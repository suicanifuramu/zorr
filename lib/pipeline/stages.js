// stages.js — extraction pipeline stage machinery: fetch, AST parse+inject,
// protocol-version scan, tx resolvers, VM execution and handshake wait.
// Split out of extraction_pipeline.js (which keeps cache + orchestration).
import * as acorn from "acorn";
import { fetchObfuscatedSource } from "../../source_fetcher.js";
import { findCandidates, injectCaptures } from "../../ast_capture.js";
import { createZorrSandbox } from "../../sandbox_factory.js";
import { classify } from "../../shape_classifier.js";
// P10: Worker-thread support (opt-in via ZORR_USE_VM_WORKER=1)
import * as _workerClientMod from "../../vm_worker_client.js";
const _useWorker = process.env.ZORR_USE_VM_WORKER === "1";
const _workerClient = _useWorker ? _workerClientMod : null;
// ============================================================================
// tx resolver: maps any const/let name (anywhere in the AST) to its string
// array value. Two flavours are recognised:
//
//   1. Static: `const tx = ["a", "b", "c", ...]` — literal string array,
//      resolvable from the AST alone.
//
//   2. Dynamic: `const tz = [Od(1234), Od(5678), ...]` — each element is
//      a call to a captured function. We record the (name, [argN, ...])
//      pair; the caller (extraction_pipeline) resolves them later by
//      calling the captured function with each arg.
//
// In both cases the resulting value is a string array of length >= 5
// (anything shorter is unlikely to be a biome list).
// ============================================================================
function _buildTxResolver(source) {
    const resolver = new Map();
    try {
        const ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: "script" });
        const walk = (node) => {
            if (!node || typeof node !== "object") return;
            if (Array.isArray(node)) {
                for (const x of node) walk(x);
                return;
            }
            if (
                node.type === "VariableDeclarator" &&
                node.id &&
                node.id.type === "Identifier" &&
                !resolver.has(node.id.name) &&
                node.init &&
                node.init.type === "ArrayExpression"
            ) {
                const els = node.init.elements;
                // Try static: all literal strings
                const staticArr = els
                    .map((e) => (e && e.type === "Literal" && typeof e.value === "string" ? e.value : null))
                    .filter((n) => typeof n === "string");
                if (staticArr.length >= 5) {
                    resolver.set(node.id.name, staticArr);
                } else {
                    // Try dynamic: all CallExpression of Identifier with numeric literal arg
                    const dynArgs = els
                        .map((e) => {
                            if (
                                e &&
                                e.type === "CallExpression" &&
                                e.callee &&
                                e.callee.type === "Identifier" &&
                                e.arguments.length === 1 &&
                                e.arguments[0].type === "Literal" &&
                                typeof e.arguments[0].value === "number"
                            ) {
                                return { fn: e.callee.name, arg: e.arguments[0].value };
                            }
                            return null;
                        })
                        .filter((x) => x);
                    if (dynArgs.length >= 5) {
                        resolver.set(node.id.name, { __dynamic: true, calls: dynArgs });
                    }
                }
            }
            for (const k of Object.keys(node)) {
                if (
                    k === "loc" ||
                    k === "start" ||
                    k === "end" ||
                    k === "type" ||
                    k === "range" ||
                    k === "raw" ||
                    k === "comments"
                )
                    continue;
                walk(node[k]);
            }
        };
        walk(ast);
    } catch (_) {
        /* ignore parse errors; resolver stays empty */
    }
    return resolver;
}

/**
 * Resolve any dynamic entries in the resolver using the callResolver
 * (captured function references). Dynamic entries are turned into
 * regular string arrays; failures are recorded as `null` slots.
 */
function _resolveDynamicResolver(resolver, callResolver) {
    for (const [name, value] of resolver.entries()) {
        if (!value || !value.__dynamic) continue;
        const out = [];
        for (const { fn, arg } of value.calls) {
            const f = callResolver.get(fn);
            if (typeof f === "function") {
                try {
                    const r = f(arg);
                    out.push(typeof r === "string" ? r : null);
                } catch (_) {
                    out.push(null);
                }
            } else {
                out.push(null);
            }
        }
        resolver.set(name, out);
    }
}

// ============================================================================
// Main extraction: fetch + AST + VM + captures (one cycle)
// ============================================================================

// P8: Stage-split retry. Only the network stage retries; parse, VM, and
// handshake failures are surfaced immediately (no double-VM, no double-fetch).

/** Stage 1: fetch the obfuscated source with retry on network errors. */
async function _fetchStage({ retries }) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fetchObfuscatedSource();
        } catch (e) {
            lastErr = e;
            if (attempt < retries) {
                await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            }
        }
    }
    throw new Error(`fetch failed after ${retries + 1} attempts: ${lastErr?.message}`);
}

/** Stage 2: parse the source (one-shot; no retry). */
function _parseAndInject(source) {
    const candidates = findCandidates(source);
    const injected = injectCaptures(source, candidates);
    return { candidates, injected };
}

/**
 * Scan the source AST for the protocol version by finding the
 * `$48(0, <var>)` pattern (setUint32 wrapper). This directly targets
 * the handshake construction code path, not mere frequency.
 */
function _scanSourceForVersion(source) {
    try {
        const ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: "script" });
        const FUNC_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

        // Walk from a node upward to find the tightest (nearest) enclosing function.
        // We do this by scanning depth-first and keeping the LAST match (innermost).
        function findEnclosingFunc(startPos) {
            let result = null;
            const walk = (node) => {
                if (!node || typeof node !== "object") return;
                if (Array.isArray(node)) {
                    for (const x of node) walk(x);
                    return;
                }
                if (FUNC_TYPES.has(node.type) && node.start <= startPos && node.end >= startPos) {
                    result = node; // keep overwriting — last match is innermost
                }
                for (const k of Object.keys(node)) {
                    if (
                        k === "loc" ||
                        k === "start" ||
                        k === "end" ||
                        k === "type" ||
                        k === "range" ||
                        k === "raw" ||
                        k === "comments"
                    )
                        continue;
                    walk(node[k]);
                }
            };
            walk(ast);
            return result;
        }

        // Collect numeric variable declarations walking up through all ancestor
        // function scopes (var is function-scoped, so inner functions see outer vars).
        function collectScopedVars(startPos) {
            const vars = new Map();
            const FUNC_TYPES_ARR = [...FUNC_TYPES];
            // Walk the entire AST, collecting var/let/const declarations
            // that are visible at startPos: declarations whose scope contains startPos.
            const walk = (node) => {
                if (!node || typeof node !== "object") return;
                if (Array.isArray(node)) {
                    for (const x of node) walk(x);
                    return;
                }
                if (FUNC_TYPES.has(node.type)) {
                    // Only enter functions whose range contains startPos
                    if (node.start <= startPos && node.end >= startPos) {
                        // Collect declarations in this function's body
                        const body = node.body;
                        if (body) {
                            const collectInBody = (n) => {
                                if (!n || typeof n !== "object") return;
                                if (Array.isArray(n)) {
                                    for (const x of n) collectInBody(x);
                                    return;
                                }
                                // Skip nested functions (they have their own scope)
                                if (FUNC_TYPES.has(n.type) && n !== node) return;
                                if (
                                    n.type === "VariableDeclarator" &&
                                    n.id &&
                                    n.id.type === "Identifier" &&
                                    n.init &&
                                    n.init.type === "Literal" &&
                                    typeof n.init.value === "number"
                                ) {
                                    if (!vars.has(n.id.name)) vars.set(n.id.name, n.init.value);
                                }
                                for (const k of Object.keys(n)) {
                                    if (
                                        k === "loc" ||
                                        k === "start" ||
                                        k === "end" ||
                                        k === "type" ||
                                        k === "range" ||
                                        k === "raw" ||
                                        k === "comments"
                                    )
                                        continue;
                                    collectInBody(n[k]);
                                }
                            };
                            collectInBody(body);
                        }
                    }
                }
                for (const k of Object.keys(node)) {
                    if (
                        k === "loc" ||
                        k === "start" ||
                        k === "end" ||
                        k === "type" ||
                        k === "range" ||
                        k === "raw" ||
                        k === "comments"
                    )
                        continue;
                    walk(node[k]);
                }
            };
            walk(ast);
            return vars;
        }

        // Find DataView constructor nodes with their enclosing function scope
        const dvEntries = []; // {name, startPos, scopedVars}
        const findDV = (node) => {
            if (!node || typeof node !== "object") return;
            if (Array.isArray(node)) {
                for (const x of node) findDV(x);
                return;
            }
            if (
                node.type === "VariableDeclarator" &&
                node.id &&
                node.id.type === "Identifier" &&
                node.init &&
                node.init.type === "NewExpression" &&
                node.init.callee &&
                node.init.callee.type === "Identifier" &&
                node.init.callee.name === "DataView" &&
                node.init.arguments &&
                node.init.arguments.length >= 1 &&
                node.init.arguments[0] &&
                node.init.arguments[0].type === "NewExpression" &&
                node.init.arguments[0].callee &&
                node.init.arguments[0].callee.type === "Identifier" &&
                node.init.arguments[0].callee.name === "ArrayBuffer"
            ) {
                const scopedVars = collectScopedVars(node.start);
                dvEntries.push({ name: node.id.name, startPos: node.start, scopedVars });
            }
            for (const k of Object.keys(node)) {
                if (
                    k === "loc" ||
                    k === "start" ||
                    k === "end" ||
                    k === "type" ||
                    k === "range" ||
                    k === "raw" ||
                    k === "comments"
                )
                    continue;
                findDV(node[k]);
            }
        };
        findDV(ast);

        // For each DataView entry, find the handshake pattern:
        // X.method(y++, ...) [setUint8] then X.method(y, version) [setUint32]
        for (const entry of dvEntries) {
            const scopedVars = entry.scopedVars;
            function resolveArg(arg) {
                if (!arg) return null;
                if (arg.type === "Literal" && typeof arg.value === "number") return arg.value;
                if (arg.type === "Identifier" && scopedVars.has(arg.name)) return scopedVars.get(arg.name);
                return null;
            }

            let found = null;
            const scan = (node, parent) => {
                if (found || !node || typeof node !== "object") return;
                if (Array.isArray(node)) {
                    for (const x of node) scan(x, node);
                    return;
                }

                if (
                    node.type === "CallExpression" &&
                    node.callee &&
                    node.callee.type === "MemberExpression" &&
                    node.callee.object &&
                    node.callee.object.type === "Identifier" &&
                    node.callee.object.name === entry.name &&
                    node.arguments &&
                    node.arguments.length >= 2
                ) {
                    const v = resolveArg(node.arguments[1]);
                    if (v !== null && v >= 1 && v <= 1000) {
                        if (parent && Array.isArray(parent)) {
                            for (const sib of parent) {
                                if (sib === node) continue;
                                if (
                                    sib &&
                                    sib.type === "CallExpression" &&
                                    sib.callee &&
                                    sib.callee.type === "MemberExpression" &&
                                    sib.callee.object &&
                                    sib.callee.object.type === "Identifier" &&
                                    sib.callee.object.name === entry.name &&
                                    sib.arguments &&
                                    sib.arguments.length >= 1
                                ) {
                                    const hasUpdate = sib.arguments.some(
                                        (a) =>
                                            a &&
                                            (a.type === "UpdateExpression" ||
                                                (a.type === "SequenceExpression" &&
                                                    a.expressions.some((e) => e.type === "UpdateExpression")))
                                    );
                                    if (hasUpdate) {
                                        found = v;
                                        return;
                                    }
                                }
                            }
                        }
                    }
                }
                for (const k of Object.keys(node)) {
                    if (
                        k === "loc" ||
                        k === "start" ||
                        k === "end" ||
                        k === "type" ||
                        k === "range" ||
                        k === "raw" ||
                        k === "comments"
                    )
                        continue;
                    scan(node[k], node);
                }
            };
            scan(ast, null);
            if (found) return found;
        }

        return null;
    } catch (_) {
        return null;
    }
}

/**
 * P5: classify captured values into the 4 game-data kinds. Pure
 * function (no VM) so it runs in the main thread even when the VM
 * itself is offloaded to a worker.
 */
function _classifyCaptured(captured, candidates) {
    const classified = { rarity: null, variant: null, petal: null, mob: null, biomeMobs: null };
    const classifiedSizes = { variant: 0, petal: 0, mob: 0, biomeMobs: 0 };
    for (const c of candidates) {
        if (classified.rarity && classified.variant && classified.petal && classified.mob && classified.biomeMobs)
            break;
        const v = captured[c.name];
        if (v == null) continue;
        const result = classify(v);
        if (process.env.ZORR_DEBUG) {
            console.log(`[classify] ${c.name} =`, v && v.length, "kind:", result ? result.kind : "null");
        }
        if (result && !classified[result.kind]) {
            classified[result.kind] = result.items;
            if (result.kind in classifiedSizes) {
                classifiedSizes[result.kind] = Array.isArray(result.items)
                    ? result.items.length
                    : result.items && typeof result.items === "object"
                      ? Object.keys(result.items).length
                      : 0;
            }
        } else if (result && result.kind in classifiedSizes) {
            const newSize = Array.isArray(result.items)
                ? result.items.length
                : result.items && typeof result.items === "object"
                  ? Object.keys(result.items).length
                  : 0;
            if (newSize > classifiedSizes[result.kind]) {
                classified[result.kind] = result.items;
                classifiedSizes[result.kind] = newSize;
            }
        }
    }
    return classified;
}

/**
 * Stage 3: run the VM and classify the captures (one-shot).
 *
 * P10: When ZORR_USE_VM_WORKER=1, the VM is offloaded to a worker
 * thread (vm_worker.js via vm_worker_client.js) so the main thread
 * is not blocked during the ~400ms CPU-bound execution.
 */
async function _runVmStage({ injected, candidates, timeout }) {
    let captured;
    let vmRunMs;
    let getHandshakeState;
    let protocolVersion = null;
    let handshakeReceived = false;
    let _deferredCleanup = null;

    if (_useWorker) {
        // Worker path: VM runs in a separate thread. The captured values
        // are JSON-serialized in the worker (to avoid structured-clone
        // failures on native functions) and deserialized here.
        const job = await _workerClient.runInWorker({
            injected,
            candidates,
            timeout,
            includeProtocol: true,
            handshakeMaxWaitMs: 3000,
        });
        captured = JSON.parse(job.capturedJson);
        vmRunMs = job.vmRunMs;
        // The worker has already waited for the handshake. The "state"
        // returned to stage 4 always indicates ready.
        const pv = job.protocolVersion;
        if (pv !== null) protocolVersion = pv;
        getHandshakeState = () => ({ handshakeReceived: true, protocolVersion });
    } else {
        // In-process path (default): same as before

        const sandboxApi = createZorrSandbox({
            hooks: {
                onWebSocketOpen: () => {
                    handshakeReceived = true;
                },
                onWebSocketSend: (bytes) => {
                    if (protocolVersion !== null) return;
                    if (bytes.length >= 5 && bytes[0] === 0) {
                        try {
                            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                            protocolVersion = view.getUint32(1);
                        } catch (_) {
                            /* ignore malformed */
                        }
                    }
                },
                onDataViewSetUint32: (byteOffset, value) => {
                    if (protocolVersion !== null) return;
                    if (byteOffset >= 0 && byteOffset <= 4 && value >= 400 && value <= 1000) {
                        protocolVersion = value;
                    }
                },
            },
        });

        const t0 = Date.now();
        // Suppress unhandled Promise rejections from the VM (the game
        // code may create async operations that reject after the
        // synchronous VM run has finished, e.g. tW.Cu internals).
        const onRej = () => {};
        process.on("unhandledRejection", onRej);
        try {
            sandboxApi.runScript(injected, { filename: "zorr.js", timeout });
        } finally {
            process.off("unhandledRejection", onRej);
            // P4: Restore Array/Map prototype patches immediately.
            // DataView.prototype.setUint32 is deferred until after the
            // handshake wait completes (the game builds the handshake
            // inside MockWebSocket.onopen which fires via setTimeout(10)
            // AFTER runScript() returns).
            if (typeof sandboxApi.cleanupPartial === "function") {
                sandboxApi.cleanupPartial();
            }
        }
        vmRunMs = Date.now() - t0;

        // Collect captured game-data values
        captured = {};
        for (const c of candidates) {
            const v = sandboxApi.sandbox["__zorr_" + c.name];
            captured[c.name] = v === undefined ? null : v;
        }

        // Live references: the hook closures may still mutate these
        // after this function returns (the WebSocket onopen fires via
        // setTimeout(10ms) AFTER the VM finishes). Hand them off as
        // getters so stage 4 can poll the current state.
        getHandshakeState = () => ({
            handshakeReceived,
            protocolVersion,
        });
        // Expose cleanup for deferred DataView prototype restoration
        _deferredCleanup = () => {
            if (typeof sandboxApi.cleanup === "function") {
                sandboxApi.cleanup();
            }
        };
    }

    const classified = _classifyCaptured(captured, candidates);

    // Fallback: check captured values for a protocol-version candidate
    // from numeric-literal variable declarations (420-460 range).
    if (protocolVersion === null) {
        const versionCands = candidates.filter((c) => c.initKind === "version");
        if (versionCands.length > 0 && process.env.ZORR_DEBUG) {
            console.log(`[debug] version candidates (${versionCands.length}):`);
            for (const c of versionCands) {
                const v = captured[c.name];
                console.log(`  ${c.name} = ${v} (${typeof v})`);
            }
        }
        for (const c of versionCands) {
            const v = captured[c.name];
            if (typeof v === "number" && v >= 1 && v <= 1000) {
                protocolVersion = v;
                break;
            }
        }
    }

    return { captured, classified, vmRunMs, getHandshakeState, deferredCleanup: _deferredCleanup };
}

/** Stage 4: wait for the WebSocket handshake (one-shot, hard cap). */
async function _waitForHandshake(getState, { includeProtocol, handshakeMaxWaitMs }) {
    if (!includeProtocol) {
        const { protocolVersion } = getState();
        return { protocolVersion };
    }
    const tWaitStart = Date.now();
    for (;;) {
        const { handshakeReceived } = getState();
        if (handshakeReceived) break;
        if (Date.now() - tWaitStart >= handshakeMaxWaitMs) break;
        await new Promise((r) => setTimeout(r, 20));
    }
    const { handshakeReceived, protocolVersion } = getState();
    if (handshakeReceived && protocolVersion === null) {
        await new Promise((r) => setTimeout(r, 200));
    }
    return { protocolVersion: getState().protocolVersion };
}

/** Parse the source once and return the root AST node. Throws on parse error (caller catches). */
function _parseRootAst(source) {
    return acorn.parse(source, { ecmaVersion: 2022, sourceType: "script" });
}

export { _parseRootAst, _buildTxResolver, _resolveDynamicResolver };
export { _fetchStage, _parseAndInject, _scanSourceForVersion, _classifyCaptured, _runVmStage, _waitForHandshake };
