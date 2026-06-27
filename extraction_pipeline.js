/**
 * extraction_pipeline.js
 *
 * Unified fetch + VM extraction pipeline. The single entry point for
 * any extraction that needs to inspect the live Zorr game source.
 *
 * Replaces the duplicated fetch + VM work previously split between:
 *   - extractGameData() (game data only)
 *   - extractProtocolVersion() (protocol version only)
 *
 * In-process cache (TTL = Infinity by default) coalesces concurrent
 * and sequential calls, ensuring only one HTTPS fetch + one VM run
 * per process per (source URL, forced refresh) pair.
 *
 * The handshake wait is dynamic: a promise resolves the moment the
 * mock WebSocket's onopen fires, with a configurable hard cap so
 * callers that don't need the protocol version can skip it.
 */
const vm = require('vm');
const { fetchObfuscatedSource, fetchJsUrlFromHtml } = require('./source_fetcher');
const { findCandidates, findFunctionBody, injectCaptures } = require('./ast_capture');
const { createZorrSandbox } = require('./sandbox_factory');
const { classify } = require('./shape_classifier');
const {
    normalizeRarities,
    normalizeVariants,
    normalizePetals,
    normalizeMobs,
    normalizeTalents,
    normalizeBiomeMobs,
    normalizeServerList,
    computeSnakeIndices,
} = require('./normalizers');
const _talentData = require('./talent_data');
const cacheStore = require('./cache_store');
// P10: Worker-thread support (opt-in via ZORR_USE_VM_WORKER=1)
const _useWorker = process.env.ZORR_USE_VM_WORKER === '1';
const _workerClient = _useWorker ? require('./vm_worker_client') : null;

// ============================================================================
// Cache + in-flight coalescing
// ============================================================================
let _cached = null;            // { result, expiresAt, jsUrl }
let _inflight = null;          // Promise<result>
let _lastJsUrl = null;         // jsUrl of the currently cached extraction
let _lastUrlCheckMs = 0;       // timestamp of last URL check
let _lastUrlChangeMs = 0;      // timestamp of last detected URL change
let _urlCheckTimer = null;     // P7: background interval handle

// How often to perform the cheap HTML-only URL check (ms). 60s keeps
// the check rate low while still detecting game updates promptly.
const URL_CHECK_INTERVAL_MS = 60_000;

function _logUrlChange(prev, next) {
    if (prev !== next) {
        _lastUrlChangeMs = Date.now();
        if (prev === null) {
            // First observation in this process — not a "change", just detection
            console.log(`\x1b[36m[cache] game source URL detected: ${next}\x1b[0m`);
        } else {
            console.log(`\x1b[33m[cache] game source URL changed: ${prev} -> ${next}\x1b[0m`);
        }
    }
}

function _logCacheLoad(source, url) {
    // Log once when a cache layer is loaded (memory, disk, or fresh extraction)
    // so users can distinguish a true URL change from a cache hit.
    console.log(`\x1b[36m[cache] Loaded ${source} cache: ${url}\x1b[0m`);
}

// P7: Background URL-change probe. Started lazily on first cache hit.
// Runs every URL_CHECK_INTERVAL_MS, performs a single HTML fetch, and
// invalidates the cache if the source URL changed. The timer is unref'd
// so it never blocks process exit (e.g. in short-lived CLI scripts).
function _ensureUrlCheckTimer() {
    if (_urlCheckTimer) return;
    _urlCheckTimer = setInterval(async () => {
        // Only probe if we actually have a cached extraction
        if (!_cached || !_lastJsUrl) return;
        _lastUrlCheckMs = Date.now();
        try {
            // P9: pass knownJsUrl so 304 can short-circuit to "unchanged"
            const res = await fetchJsUrlFromHtml({ knownJsUrl: _lastJsUrl });
            const currentUrl = res.jsUrl;
            if (currentUrl !== _lastJsUrl) {
                _logUrlChange(_lastJsUrl, currentUrl);
                // Invalidate the cache; the next getOrComputeExtraction
                // call (if any) will see a cache miss and re-extract.
                _cached = null;
                _lastJsUrl = null;
            }
        } catch (e) {
            // Network blip: keep the cached value, retry next tick
            if (process.env.ZORR_DEBUG) {
                console.error(`[cache] URL check failed: ${e.message}`);
            }
        }
    }, URL_CHECK_INTERVAL_MS);
    if (typeof _urlCheckTimer.unref === 'function') _urlCheckTimer.unref();
}

/**
 * Return a snapshot of the current cache state (for diagnostics / /config/refresh etc.).
 * @returns {{cached: boolean, jsUrl: string|null, age: number, lastCheck: number, lastChange: number, diskCached: boolean}}
 */
function getCacheStatus() {
    return {
        cached: _cached !== null,
        jsUrl: _lastJsUrl,
        fetchedAt: _cached?.result?.fetchedAt ?? null,
        age: _cached ? (Date.now() - new Date(_cached.result.fetchedAt).getTime()) : 0,
        lastCheck: _lastUrlCheckMs,
        lastChange: _lastUrlChangeMs,
        diskCached: cacheStore.cacheExists(),
        diskPath: cacheStore.cachePath(),
    };
}

/**
 * Invalidate the in-process cache. Next call to getOrComputeExtraction
 * will perform a fresh fetch + VM run. The cached jsUrl is also cleared
 * so the next call will perform a URL-change probe on its first cache miss.
 * The background URL check timer is left running; it will simply have
 * nothing to check until a new cache is populated.
 *
 * P11: also clears the on-disk cache. Pass {keepDiskCache: true} to
 * only invalidate the in-process layer (useful for unit tests).
 */
function invalidateCache(opts = {}) {
    _cached = null;
    _inflight = null;
    _lastJsUrl = null;
    _lastUrlCheckMs = 0;
    if (!opts.keepDiskCache) {
        cacheStore.clearCache();
    }
}

/**
 * Parse the source once and return the root AST node. Used by the
 * server-list shape scan. Throws on parse error (caller catches).
 */
function _parseRootAst(source) {
    return acorn.parse(source, { ecmaVersion: 2022, sourceType: 'script' });
}

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
const acorn = require('acorn');

function _buildTxResolver(source) {
    const resolver = new Map();
    try {
        const ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: 'script' });
        const walk = (node) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) { for (const x of node) walk(x); return; }
            if (node.type === 'VariableDeclarator'
                && node.id && node.id.type === 'Identifier'
                && !resolver.has(node.id.name)
                && node.init && node.init.type === 'ArrayExpression') {
                const els = node.init.elements;
                // Try static: all literal strings
                const staticArr = els
                    .map(e => e && e.type === 'Literal' && typeof e.value === 'string' ? e.value : null)
                    .filter(n => typeof n === 'string');
                if (staticArr.length >= 5) {
                    resolver.set(node.id.name, staticArr);
                } else {
                    // Try dynamic: all CallExpression of Identifier with numeric literal arg
                    const dynArgs = els
                        .map(e => {
                            if (e && e.type === 'CallExpression'
                                && e.callee && e.callee.type === 'Identifier'
                                && e.arguments.length === 1
                                && e.arguments[0].type === 'Literal'
                                && typeof e.arguments[0].value === 'number') {
                                return { fn: e.callee.name, arg: e.arguments[0].value };
                            }
                            return null;
                        })
                        .filter(x => x);
                    if (dynArgs.length >= 5) {
                        resolver.set(node.id.name, { __dynamic: true, calls: dynArgs });
                    }
                }
            }
            for (const k of Object.keys(node)) {
                if (k === 'loc' || k === 'start' || k === 'end' || k === 'type'
                    || k === 'range' || k === 'raw' || k === 'comments') continue;
                walk(node[k]);
            }
        };
        walk(ast);
    } catch (_) { /* ignore parse errors; resolver stays empty */ }
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
            if (typeof f === 'function') {
                try {
                    const r = f(arg);
                    out.push(typeof r === 'string' ? r : null);
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
// Normalize per-mob snake detection (Phase A verified: snakeCount on 9/178 mobs)
// ============================================================================
function extractSnakeIndicesFromRaw(mobs) {
    const indices = [];
    for (let i = 0; i < mobs.length; i++) {
        const m = mobs[i];
        if (m && typeof m === 'object' && 'snakeCount' in m
            && typeof m.snakeCount === 'number' && m.snakeCount > 0) {
            indices.push(i);
        }
    }
    return indices;
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
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
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
        const ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: 'script' });
        const FUNC_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

        // Walk from a node upward to find the tightest (nearest) enclosing function.
        // We do this by scanning depth-first and keeping the LAST match (innermost).
        function findEnclosingFunc(startPos) {
            let result = null;
            const walk = (node) => {
                if (!node || typeof node !== 'object') return;
                if (Array.isArray(node)) { for (const x of node) walk(x); return; }
                if (FUNC_TYPES.has(node.type) && node.start <= startPos && node.end >= startPos) {
                    result = node; // keep overwriting — last match is innermost
                }
                for (const k of Object.keys(node)) {
                    if (k === 'loc' || k === 'start' || k === 'end' || k === 'type'
                        || k === 'range' || k === 'raw' || k === 'comments') continue;
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
                if (!node || typeof node !== 'object') return;
                if (Array.isArray(node)) { for (const x of node) walk(x); return; }
                if (FUNC_TYPES.has(node.type)) {
                    // Only enter functions whose range contains startPos
                    if (node.start <= startPos && node.end >= startPos) {
                        // Collect declarations in this function's body
                        const body = node.body;
                        if (body) {
                            const collectInBody = (n) => {
                                if (!n || typeof n !== 'object') return;
                                if (Array.isArray(n)) { for (const x of n) collectInBody(x); return; }
                                // Skip nested functions (they have their own scope)
                                if (FUNC_TYPES.has(n.type) && n !== node) return;
                                if (n.type === 'VariableDeclarator'
                                    && n.id && n.id.type === 'Identifier'
                                    && n.init && n.init.type === 'Literal'
                                    && typeof n.init.value === 'number') {
                                    if (!vars.has(n.id.name)) vars.set(n.id.name, n.init.value);
                                }
                                for (const k of Object.keys(n)) {
                                    if (k === 'loc' || k === 'start' || k === 'end' || k === 'type'
                                        || k === 'range' || k === 'raw' || k === 'comments') continue;
                                    collectInBody(n[k]);
                                }
                            };
                            collectInBody(body);
                        }
                    }
                }
                for (const k of Object.keys(node)) {
                    if (k === 'loc' || k === 'start' || k === 'end' || k === 'type'
                        || k === 'range' || k === 'raw' || k === 'comments') continue;
                    walk(node[k]);
                }
            };
            walk(ast);
            return vars;
        }

        // Find DataView constructor nodes with their enclosing function scope
        const dvEntries = []; // {name, startPos, scopedVars}
        const findDV = (node) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) { for (const x of node) findDV(x); return; }
            if (node.type === 'VariableDeclarator'
                && node.id && node.id.type === 'Identifier'
                && node.init && node.init.type === 'NewExpression'
                && node.init.callee && node.init.callee.type === 'Identifier'
                && node.init.callee.name === 'DataView'
                && node.init.arguments && node.init.arguments.length >= 1
                && node.init.arguments[0] && node.init.arguments[0].type === 'NewExpression'
                && node.init.arguments[0].callee && node.init.arguments[0].callee.type === 'Identifier'
                && node.init.arguments[0].callee.name === 'ArrayBuffer') {
                const scopedVars = collectScopedVars(node.start);
                dvEntries.push({ name: node.id.name, startPos: node.start, scopedVars });
            }
            for (const k of Object.keys(node)) {
                if (k === 'loc' || k === 'start' || k === 'end' || k === 'type'
                    || k === 'range' || k === 'raw' || k === 'comments') continue;
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
                if (arg.type === 'Literal' && typeof arg.value === 'number') return arg.value;
                if (arg.type === 'Identifier' && scopedVars.has(arg.name)) return scopedVars.get(arg.name);
                return null;
            }

            let found = null;
            const scan = (node, parent) => {
                if (found || !node || typeof node !== 'object') return;
                if (Array.isArray(node)) { for (const x of node) scan(x, node); return; }

                if (node.type === 'CallExpression'
                    && node.callee && node.callee.type === 'MemberExpression'
                    && node.callee.object && node.callee.object.type === 'Identifier'
                    && node.callee.object.name === entry.name
                    && node.arguments && node.arguments.length >= 2) {
                    const v = resolveArg(node.arguments[1]);
                    if (v !== null && v >= 1 && v <= 1000) {
                        if (parent && Array.isArray(parent)) {
                            for (const sib of parent) {
                                if (sib === node) continue;
                                if (sib && sib.type === 'CallExpression'
                                    && sib.callee && sib.callee.type === 'MemberExpression'
                                    && sib.callee.object && sib.callee.object.type === 'Identifier'
                                    && sib.callee.object.name === entry.name
                                    && sib.arguments && sib.arguments.length >= 1) {
                                    const hasUpdate = sib.arguments.some(a =>
                                        a && (a.type === 'UpdateExpression'
                                            || (a.type === 'SequenceExpression'
                                                && a.expressions.some(e => e.type === 'UpdateExpression'))));
                                    if (hasUpdate) {
                                        found = v; return;
                                    }
                                }
                            }
                        }
                    }
                }
                for (const k of Object.keys(node)) {
                    if (k === 'loc' || k === 'start' || k === 'end' || k === 'type'
                        || k === 'range' || k === 'raw' || k === 'comments') continue;
                    scan(node[k], node);
                }
            };
            scan(ast, null);
            if (found) return found;
        }

        return null;
    } catch (_) { return null; }
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
        if (classified.rarity && classified.variant && classified.petal && classified.mob && classified.biomeMobs) break;
        const v = captured[c.name];
        if (v == null) continue;
        const result = classify(v);
        if (process.env.ZORR_DEBUG) {
            console.log(`[classify] ${c.name} =`, v && v.length, 'kind:', result ? result.kind : 'null');
        }
        if (result && !classified[result.kind]) {
            classified[result.kind] = result.items;
            if (result.kind in classifiedSizes) {
                classifiedSizes[result.kind] = Array.isArray(result.items) ? result.items.length
                    : (result.items && typeof result.items === 'object' ? Object.keys(result.items).length : 0);
            }
        } else if (result && result.kind in classifiedSizes) {
            const newSize = Array.isArray(result.items) ? result.items.length
                : (result.items && typeof result.items === 'object' ? Object.keys(result.items).length : 0);
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
            injected, candidates, timeout,
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
                onWebSocketOpen: () => { handshakeReceived = true; },
                onWebSocketSend: (bytes) => {
                    if (protocolVersion !== null) return;
                    if (bytes.length >= 5 && bytes[0] === 0) {
                        try {
                            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                            protocolVersion = view.getUint32(1);
                        } catch (_) { /* ignore malformed */ }
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
        process.on('unhandledRejection', onRej);
        try {
            sandboxApi.runScript(injected, { filename: 'zorr.js', timeout });
        } finally {
            process.off('unhandledRejection', onRej);
            // P4: Restore Array/Map prototype patches immediately.
            // DataView.prototype.setUint32 is deferred until after the
            // handshake wait completes (the game builds the handshake
            // inside MockWebSocket.onopen which fires via setTimeout(10)
            // AFTER runScript() returns).
            if (typeof sandboxApi.cleanupPartial === 'function') {
                sandboxApi.cleanupPartial();
            }
        }
        vmRunMs = Date.now() - t0;

        // Collect captured game-data values
        captured = {};
        for (const c of candidates) {
            const v = sandboxApi.sandbox['__zorr_' + c.name];
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
            if (typeof sandboxApi.cleanup === 'function') {
                sandboxApi.cleanup();
            }
        };
    }

    const classified = _classifyCaptured(captured, candidates);

    // Fallback: check captured values for a protocol-version candidate
    // from numeric-literal variable declarations (420-460 range).
    if (protocolVersion === null) {
        const versionCands = candidates.filter(c => c.initKind === 'version');
        if (versionCands.length > 0 && process.env.ZORR_DEBUG) {
            console.log(`[debug] version candidates (${versionCands.length}):`);
            for (const c of versionCands) {
                const v = captured[c.name];
                console.log(`  ${c.name} = ${v} (${typeof v})`);
            }
        }
        for (const c of versionCands) {
            const v = captured[c.name];
            if (typeof v === 'number' && v >= 1 && v <= 1000) {
                protocolVersion = v;
                break;
            }
        }
    }

    return { captured, classified, vmRunMs, getHandshakeState, deferredCleanup: _deferredCleanup };
}

/** Stage 4: wait for the WebSocket handshake (one-shot, hard cap). */
async function _waitForHandshake(getState, {
    includeProtocol, handshakeMaxWaitMs,
}) {
    if (!includeProtocol) {
        const { protocolVersion } = getState();
        return { protocolVersion };
    }
    const tWaitStart = Date.now();
    for (;;) {
        const { handshakeReceived } = getState();
        if (handshakeReceived) break;
        if (Date.now() - tWaitStart >= handshakeMaxWaitMs) break;
        await new Promise(r => setTimeout(r, 20));
    }
    const { handshakeReceived, protocolVersion } = getState();
    if (handshakeReceived && protocolVersion === null) {
        await new Promise(r => setTimeout(r, 200));
    }
    return { protocolVersion: getState().protocolVersion };
}

/**
 * Run a single fetch + VM extraction cycle. Returns the unified result.
 *
 * @param {Object} [options]
 * @param {number} [options.timeout=30000]  VM execution timeout (ms)
 * @param {number} [options.retries=2]      fetch retry count
 * @param {boolean} [options.includeProtocol=true]  wait for WebSocket handshake
 * @param {number} [options.handshakeMaxWaitMs=3000] hard cap for handshake wait
 * @param {boolean} [options.includeSource=false]  include raw source string in result (P2; default dropped to save 1.4MB)
 * @returns {Promise<{
 *   source: string|undefined,           // included only when options.includeSource=true
 *   jsUrl: string,
 *   htmlUrl: string,
 *   protocolVersion: number|null,
 *   rarities: Array,
 *   variants: Array,
 *   petals: Array,
 *   mobs: Array,
 *   snakeMobIndices: number[],
 *   snakeMethod: string,
 *   vmRunMs: number,
 *   fetchedAt: string,
 * }>}
 */
async function runFullExtraction({
    timeout = 30000,
    retries = 2,
    includeProtocol = true,
    handshakeMaxWaitMs = 3000,
    includeSource = false,
} = {}) {
    const fetchedAt = new Date().toISOString();

    // Stage 1: fetch (with retry)
    const { source, jsUrl, htmlUrl } = await _fetchStage({ retries });

    // Stage 2: parse + inject (one-shot)
    const { candidates, injected } = _parseAndInject(source);

    // Stage 3: VM + classify (one-shot; async due to P10 worker support)
    const { captured, classified, vmRunMs, getHandshakeState, deferredCleanup } = await _runVmStage({
        injected, candidates, timeout,
    });

    // Validate classification completeness (4 core kinds are required)
    if (!classified.rarity || !classified.variant
        || !classified.petal || !classified.mob) {
        throw new Error(
            `Incomplete classification: ` +
            `rarity=${!!classified.rarity} ` +
            `variant=${!!classified.variant} ` +
            `petal=${!!classified.petal} ` +
            `mob=${!!classified.mob}`
        );
    }

    // Static region/biome extraction by AST shape scan. The obfuscation
    // renames the function/identifier/property names between versions
    // (e.g. tU/tW, items/[1085], tx/tz, Su/zu), so we search the entire
    // AST for the structural invariant: a 2-element ArrayExpression of
    // ObjectExpressions matching the server-selector tabs literal. The
    // biome identifier is resolved via a name→array map; we combine:
    //   1. Static resolver: const X = [literal-string, ...] (deobfuscated
    //      source has them inline)
    //   2. Runtime resolver: any captured variable that's a string array
    //      (live source uses Od(1234) calls that resolve at VM time)
    // If the shape ever changes drastically, the search returns empty
    // arrays and the UI shows empty dropdowns (warn-only).
    const txResolver = _buildTxResolver(source);
    // Build a call-resolver for function captures (e.g. the Od() string-
    // lookup function used in the live source to obfuscate constant
    // strings like color hex codes). We also resolve any dynamic tx
    // entries (e.g. `tz = [Od(1234), ...]`) by invoking the captured
    // function with each numeric arg.
    const callResolver = new Map();
    for (const c of candidates) {
        const v = captured[c.name];
        if (typeof v === 'function') {
            callResolver.set(c.name, v);
        }
    }
    // Expand with local aliases: inside each function body, declarations
    // like `const t = Od;` (or `let n = e;`) introduce a local name that
    // refers to the same function value. Scan all VariableDeclarators and
    // add the alias when the right-hand Identifier is already resolvable
    // (directly in callResolver or via another alias we've already added).
    // The scan iterates until no new aliases are found (transitive closure).
    let added = true;
    while (added) {
        added = false;
        try {
            const ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: 'script' });
            const walk = (node) => {
                if (!node || typeof node !== 'object') return;
                if (Array.isArray(node)) { for (const x of node) walk(x); return; }
                if (node.type === 'VariableDeclarator'
                    && node.id && node.id.type === 'Identifier'
                    && node.init && node.init.type === 'Identifier'
                    && !callResolver.has(node.id.name)) {
                    const target = callResolver.get(node.init.name);
                    if (typeof target === 'function') {
                        callResolver.set(node.id.name, target);
                        added = true;
                    }
                }
                for (const k of Object.keys(node)) {
                    if (k === 'loc' || k === 'start' || k === 'end' || k === 'type'
                        || k === 'range' || k === 'raw' || k === 'comments') continue;
                    walk(node[k]);
                }
            };
            walk(ast);
        } catch (_) { /* parse error stops alias expansion */ }
    }
    if (process.env.ZORR_DEBUG) console.log(`[debug] callResolver keys:`, Array.from(callResolver.keys()), 'Od captured:', callResolver.has('Od'));
    _resolveDynamicResolver(txResolver, callResolver);
    const rootAst = _parseRootAst(source);
    const { regions, biomes, functionName } = normalizeServerList(rootAst, txResolver, callResolver);
    if (regions.length === 0 && biomes.length === 0) {
        console.log(`\x1b[33m[warn] server-list tabs not found in AST; map.html will show empty region/biome dropdowns\x1b[0m`);
    } else {
        console.log(`\x1b[36m[extraction] server-list: ${regions.length} regions, ${biomes.length} biomes (function: ${functionName || '?'})\x1b[0m`);
    }

    // Stage 4: handshake wait (one-shot, with hard cap)
    let { protocolVersion } = await _waitForHandshake(
        getHandshakeState,
        { includeProtocol, handshakeMaxWaitMs }
    );

    // Now safe to restore DataView.prototype.setUint32 (the handshake
    // wait is complete; the game's onopen has already fired).
    if (typeof deferredCleanup === 'function') deferredCleanup();

    // Stage 4b: static source scan fallback if handshake didn't yield a version
    if (protocolVersion === null && includeProtocol) {
        const scannedVersion = _scanSourceForVersion(source);
        if (scannedVersion !== null) {
            protocolVersion = scannedVersion;
            if (process.env.ZORR_DEBUG) console.log(`[extraction] protocol version from source scan: ${protocolVersion}`);
        }
    }

    // Keep raw mob references for snake detection (snakeCount is a
    // property that the normalizer may drop). We re-derive indices
    // from the raw mob array captured above.
    const rawMobs = classified.mob;
    const rawSnakeIndices = extractSnakeIndicesFromRaw(rawMobs);

    const rarities = normalizeRarities(classified.rarity);
    const variants = normalizeVariants(classified.variant);
    const petals = normalizePetals(classified.petal);
    const mobs = normalizeMobs(classified.mob);
    const talents = normalizeTalents(_talentData);
    let biomeMobs = normalizeBiomeMobs(classified.biomeMobs);

    // Fallback: if VM classification didn't find biomeMobs, extract it
    // directly from the source string. The game source always contains
    // the biome-mob JSON as a string literal (either standalone via
    // JSON.parse("...") or embedded in a string array).
    if (!biomeMobs || Object.keys(biomeMobs).length === 0) {
        // The biome JSON string is embedded in the source as:
        //   '{"plains":{"hornet":1,...}}'  (single-quoted, with escaped \")
        // Extract the raw JSON by finding the start marker and parsing.
        const startMarker = '"plains":{"hornet":1';
        const startIdx = source.indexOf(startMarker);
        if (startIdx >= 0) {
            // Walk back to find the opening brace
            let jsonStart = startIdx;
            while (jsonStart > 0 && source[jsonStart] !== '{') jsonStart--;
            // Walk forward to find the matching closing braces
            let depth = 0;
            let jsonEnd = jsonStart;
            while (jsonEnd < source.length) {
                if (source[jsonEnd] === '{') depth++;
                else if (source[jsonEnd] === '}') {
                    depth--;
                    if (depth === 0) { jsonEnd++; break; }
                }
                jsonEnd++;
            }
            const rawJson = source.substring(jsonStart, jsonEnd);
            try {
                biomeMobs = normalizeBiomeMobs(JSON.parse(rawJson));
            } catch (_) { /* ignore parse error */ }
        }
        if (process.env.ZORR_DEBUG) {
            console.log(`[biomeMobs-fallback] keys=${Object.keys(biomeMobs).length}`);
        }
    }
    const snakeMobIndices = computeSnakeIndices(mobs);

    // The two detection methods should agree. If they don't, prefer
    // the property-based detection (rawSnakeIndices) as authoritative.
    const agreement = rawSnakeIndices.length === snakeMobIndices.length
        && rawSnakeIndices.every((v, i) => v === snakeMobIndices[i]);
    const finalSnakeIndices = agreement ? snakeMobIndices : rawSnakeIndices;
    const snakeMethod = finalSnakeIndices.length > 0
        ? (agreement ? 'snakeCount+isSnake' : 'snakeCount')
        : 'none';

    // P2: source is conditionally included. Internally, we keep `source`
    // available on the cache so a later `includeSource: true` call can
    // reuse the same fetch without re-hitting the network.
    return {
        source,
        jsUrl, htmlUrl,
        protocolVersion,
        rarities, variants, petals, mobs, talents, biomeMobs,
        snakeMobIndices: finalSnakeIndices,
        snakeMethod,
        regions, biomes,
        vmRunMs,
        fetchedAt,
    };
}

// ============================================================================
// Cached orchestrator (coalesces concurrent calls)
// ============================================================================
/**
 * Return the cached extraction result, or perform a fresh extraction
 * (coalescing concurrent callers onto a single in-flight Promise).
 *
 * Cache layers, in order:
 *   1. In-process memory cache (TTL = Infinity by default)
 *   2. On-disk cache (P11) — survives process restarts; validated by
 *      (schemaVersion, jsUrl) so a stale disk cache is rejected
 *   3. Fresh fetch + VM extraction
 *
 * When a cache hit is available, a background setInterval (P7) checks
 * whether the game source URL has changed (HTML-only fetch, ~300ms,
 * throttled to once per URL_CHECK_INTERVAL_MS). If the URL changed,
 * the cache is invalidated and the next call re-extracts.
 *
 * @param {Object} [options]  passed through to runFullExtraction
 * @param {number} [options.ttlMs=Infinity]  in-process cache lifetime
 * @param {boolean} [options.skipUrlCheck=false]  skip the URL-change probe
 * @param {boolean} [options.includeSource=false]  include raw source string in result
 * @param {boolean} [options.skipDiskCache=false]  skip the on-disk cache
 * @returns {Promise<object>}
 */
async function getOrComputeExtraction(options = {}) {
    const {
        ttlMs = Infinity,
        skipUrlCheck = false,
        includeSource = false,
        skipDiskCache = false,
        ...runOpts
    } = options;

    // Helper: return a projection of the cached result. The full result
    // (including the 1.4MB `source` field) stays in the cache so a later
    // `includeSource: true` call can reuse the same fetch (P1).
    const project = (full) => includeSource ? full : (() => {
        const { source, ...rest } = full;
        return rest;
    })();

    // 1. In-process memory cache hit
    if (_cached && (_cached.expiresAt === Infinity || Date.now() < _cached.expiresAt)) {
        // P7: URL-change probe is now background-driven via setInterval
        // (started lazily on first cache hit). Per-call latency is
        // therefore not affected by the URL check at all.
        if (!skipUrlCheck) _ensureUrlCheckTimer();
        if (process.env.ZORR_DEBUG) _logCacheLoad('memory', _lastJsUrl);
        return project(_cached.result);
    }

    // 2. Coalesce concurrent calls
    if (_inflight) return _inflight.then(project);

    // 3. P11: On-disk cache (skip if source is requested — disk cache
    // does not store the raw source)
    if (!skipDiskCache && !includeSource) {
        const disk = cacheStore.loadCache();
        if (disk) {
            // Validate the disk cache against the current known jsUrl
            // (if we have one from a prior run). If they differ, treat
            // the disk cache as stale and re-extract.
            const matches = !_lastJsUrl || disk.jsUrl === _lastJsUrl;
            if (matches) {
                // Sanity: also verify the URL via a single HTML check
                // before accepting the disk cache (best effort).
                _cached = {
                    result: { ...disk, source: '' },
                    expiresAt: ttlMs === Infinity ? Infinity : Date.now() + ttlMs,
                };
                if (!_lastJsUrl) _lastJsUrl = disk.jsUrl;
                _logCacheLoad('disk', disk.jsUrl);
                if (!skipUrlCheck) _ensureUrlCheckTimer();
                return project(_cached.result);
            }
        }
    }

    // 4. Start a fresh extraction
    _inflight = runFullExtraction(runOpts)
        .then((result) => {
            _cached = { result, expiresAt: ttlMs === Infinity ? Infinity : Date.now() + ttlMs };
            _logUrlChange(_lastJsUrl, result.jsUrl);
            _lastJsUrl = result.jsUrl;
            // P11: persist to disk (without the raw source)
            cacheStore.saveCache(result);
            return result;
        })
        .finally(() => {
            // P3: 成功/失敗問わず常に _inflight を解放 (コード一貫性)
            _inflight = null;
        });

    return _inflight.then(project);
}

module.exports = {
    runFullExtraction,
    getOrComputeExtraction,
    invalidateCache,
    getCacheStatus,
    extractSnakeIndicesFromRaw,
    URL_CHECK_INTERVAL_MS,
    _buildTxResolver,
    _parseRootAst,
    _resolveDynamicResolver,
    _scanSourceForVersion,
};
