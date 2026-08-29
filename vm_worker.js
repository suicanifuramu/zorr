/**
 * vm_worker.js
 *
 * P10: Worker thread that runs the VM execution stage of the extraction
 * pipeline. Receives a job (injected source + candidates + handshake
 * options), executes the source in a sandbox, waits for the WebSocket
 * handshake if requested, and returns the captured game-data values.
 *
 * Communication: one worker, multiple jobs. The parent sends a job via
 * `parentPort.postMessage({ id, ... })` and receives the result via
 * `parentPort.on('message')` (matched by `id`).
 */
const { parentPort } = require("worker_threads");
const { createZorrSandbox } = require("./sandbox_factory");

if (!parentPort) {
    throw new Error("vm_worker.js must be run as a worker thread");
}

parentPort.on("message", async (job) => {
    if (process.env.ZORR_DEBUG) console.log("[worker] received message:", job ? Object.keys(job) : "null");
    if (!job || typeof job !== "object" || !("id" in job)) {
        // Not a job (e.g. a port transfer signal). Ignore.
        return;
    }
    const { id, injected, candidates, timeout, includeProtocol, handshakeMaxWaitMs } = job;
    try {
        const result = await _runVmJob({ injected, candidates, timeout, includeProtocol, handshakeMaxWaitMs });
        parentPort.postMessage({ id, ok: true, result });
    } catch (e) {
        parentPort.postMessage({ id, ok: false, error: e.message, stack: e.stack });
    }
});

async function _runVmJob({ injected, candidates, timeout, includeProtocol, handshakeMaxWaitMs }) {
    let protocolVersion = null;
    let handshakeReceived = false;

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
    const onRej = () => {};
    process.on("unhandledRejection", onRej);
    try {
        sandboxApi.runScript(injected, { filename: "zorr.js", timeout });
    } finally {
        process.off("unhandledRejection", onRej);
        // Restore Array/Map prototype patches immediately.
        // DataView.prototype.setUint32 is deferred until after the
        // handshake wait completes (game builds handshake in onopen
        // which fires via setTimeout(10) AFTER runScript() returns).
        if (typeof sandboxApi.cleanupPartial === "function") {
            sandboxApi.cleanupPartial();
        }
    }
    const vmRunMs = Date.now() - t0;

    // Collect captured game-data values
    const captured = {};
    for (const c of candidates) {
        const v = sandboxApi.sandbox["__zorr_" + c.name];
        captured[c.name] = v === undefined ? null : v;
    }

    // Stage 4: handshake wait
    if (includeProtocol) {
        const tWaitStart = Date.now();
        for (;;) {
            if (handshakeReceived) break;
            if (Date.now() - tWaitStart >= handshakeMaxWaitMs) break;
            await new Promise((r) => setTimeout(r, 20));
        }
        if (handshakeReceived && protocolVersion === null) {
            await new Promise((r) => setTimeout(r, 200));
        }
        // Fallback: check captured values for protocol version candidate
        if (protocolVersion === null) {
            for (const c of candidates) {
                if (c.initKind !== "version") continue;
                const v = captured[c.name];
                if (typeof v === "number" && v >= 1 && v <= 1000) {
                    protocolVersion = v;
                    break;
                }
            }
        }
    }

    // Now safe to restore DataView.prototype.setUint32
    if (typeof sandboxApi.cleanup === "function") {
        sandboxApi.cleanup();
    }

    // P10: structured-clone-friendly serialization.
    //
    // The captured values include:
    //   - Top-level arrays/objects (safe to clone)
    //   - Circular references between siblings (e.g. magicPetal <-> originalPetal)
    //   - Prototype methods that are native functions (e.g. Math.floor reachable
    //     via the custom prototype of the obfuscated game objects)
    //
    // Strategy: walk each value, keep scalar primitives and BOOLEAN values
    // intact, and for object/array values replace them with a marker that
    // preserves key presence. Cycles are broken at the first encounter.
    // The "truthiness" of important fields (e.g. mob.egg) is preserved
    // because we keep booleans verbatim and object-typed values become
    // a non-null marker (e.g. '[obj]') that the classifier's `if (x) return`
    // would treat as truthy.
    const CYCLE_MARKER = "__cycle__";
    const OBJ_MARKER = "[obj]";

    function serialize(value) {
        const seen = new WeakSet();
        // Walk a single item (object or scalar) and return its sanitized
        // form. For arrays, walk each element. Object values become
        // OBJ_MARKER so cycles are broken and truthiness is preserved.
        function walkItem(item) {
            if (item == null) return item;
            if (typeof item !== "object") return item;
            if (seen.has(item)) return CYCLE_MARKER;
            seen.add(item);
            if (Array.isArray(item)) {
                return item.map(walkItem);
            }
            // Plain object (e.g. Map-like variant or a single game item)
            const out = {};
            for (const k of Object.keys(item)) {
                const iv = item[k];
                if (iv == null) {
                    out[k] = iv;
                    continue;
                }
                const it = typeof iv;
                if (it === "string" || it === "number" || it === "boolean") {
                    out[k] = iv;
                } else if (it === "function") {
                    out[k] = null;
                } else {
                    // object/array (possibly cyclic) → marker
                    out[k] = OBJ_MARKER;
                }
            }
            return out;
        }
        return walkItem(value);
    }

    let capturedJson;
    try {
        const serialized = {};
        for (const k of Object.keys(captured)) {
            serialized[k] = serialize(captured[k]);
        }
        if (process.env.ZORR_DEBUG) {
            const bN = serialized.bN;
            if (Array.isArray(bN) && bN[0]) {
                console.log(
                    "[worker] serialized bN[0] parent=" +
                        JSON.stringify(bN[0].parent) +
                        " children=" +
                        JSON.stringify(bN[0].children)
                );
            }
        }
        capturedJson = JSON.stringify(serialized, (k, v) => (v === undefined ? null : v));
    } catch (e) {
        throw new Error(`vm_worker: failed to serialize captured: ${e.message}`);
    }
    return {
        capturedJson,
        protocolVersion,
        vmRunMs,
    };
}
