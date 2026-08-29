/**
 * vm_worker_client.js
 *
 * P10: Thin client that manages a single long-lived Worker thread
 * running vm_worker.js. Provides a Promise-based API:
 *
 *   const result = await runInWorker({ injected, candidates, timeout, includeProtocol, handshakeMaxWaitMs });
 *
 * Concurrent calls are coalesced onto the same worker (the worker
 * processes one job at a time, so jobs queue up). Job IDs are
 * auto-assigned.
 *
 * The worker is created lazily on first call and is unref'd so it
 * doesn't keep the process alive.
 */
const path = require("path");
const { Worker } = require("worker_threads");

let _worker = null;
let _nextId = 1;
const _pending = new Map(); // id -> { resolve, reject }

function _getWorker() {
    if (_worker) return _worker;
    const workerPath = path.join(__dirname, "vm_worker.js");
    _worker = new Worker(workerPath);
    _worker.on("message", (msg) => {
        const pending = _pending.get(msg.id);
        if (!pending) return;
        _pending.delete(msg.id);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new Error(msg.error + (msg.stack ? "\n" + msg.stack : "")));
    });
    _worker.on("error", (err) => {
        // Reject all pending and reset so next call re-creates the worker
        for (const [id, p] of _pending) p.reject(err);
        _pending.clear();
        _worker = null;
    });
    _worker.on("exit", (code) => {
        // Worker exited unexpectedly; reject pending and clear
        for (const [id, p] of _pending) p.reject(new Error(`vm_worker exited with code ${code}`));
        _pending.clear();
        _worker = null;
    });
    if (typeof _worker.unref === "function") _worker.unref();
    return _worker;
}

function runInWorker(job) {
    const w = _getWorker();
    const id = _nextId++;
    return new Promise((resolve, reject) => {
        _pending.set(id, { resolve, reject });
        w.postMessage({ id, ...job });
    });
}

function shutdown() {
    if (!_worker) return;
    const w = _worker;
    _worker = null;
    for (const [id, p] of _pending) p.reject(new Error("vm_worker shutdown"));
    _pending.clear();
    return w.terminate();
}

module.exports = { runInWorker, shutdown };
