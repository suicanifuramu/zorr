/**
 * sandbox_factory.js
 *
 * Reusable Node.js VM sandbox for executing Zorr game scripts
 * in a controlled environment. Used by:
 *   - extraction_pipeline.js (capture game data + WebSocket handshake)
 *   - protocol_extractor.js (legacy wrapper, capture WebSocket.send for protocol version)
 *   - game_data_extractor.js (legacy wrapper, capture rarities / variants / petals / mobs)
 *
 * The sandbox emulates browser globals via a recursive Proxy so the
 * game code can be executed (mostly) safely. All execution errors
 * are swallowed because the game script is not designed to run
 * outside a real browser; we only need partial execution.
 */
import vm from "node:vm";
import { TextDecoder, TextEncoder } from "node:util";

/**
 * Create a Zorr-compatible sandbox.
 *
 * @param {Object} [options]
 * @param {Object<string, Function>} [options.hooks] Optional callbacks:
 *   - onWebSocketSend(bytes: Uint8Array)         fired on WebSocket.send
 *   - onWebSocketOpen(ws: MockWebSocket)         fired when the mock's onopen is invoked
 *   - onDataViewSetUint32(byteOffset, value)     fired on DataView.prototype.setUint32
 *   - onGlobalSet(name: string, value: any)      fired on globalThis[name] = value
 *   - onArrayPush(arr: any[], item: any)         fired on Array.prototype.push
 *   - onMapSet(map: Map, key: any, value: any)   fired on Map.prototype.set
 * @returns {{
 *   sandbox: Object,
 *   ctx: vm.Context,
 *   MockWebSocket: Function,
 *   runScript: (src: string, opts?: Object) => void,
 *   captureFromGlobal: (key: string) => any,
 *   cleanup: () => void,
 *   cleanupPartial: (socketName?: string) => void,
 * }}
 */
function createZorrSandbox(options = {}) {
    const hooks = options.hooks || {};

    /**
     * Mock of the game's WebSocket class. Auto-fires onopen asynchronously;
     * dispatch() simulates incoming game frames via onmessage.
     */
    class MockWebSocket {
        constructor(url) {
            /** @type {string} */
            this.url = url;
            this.readyState = 1;
            this.binaryType = "arraybuffer";
            this._listeners = {};
            setTimeout(() => {
                let onopenSucceeded = false;
                try {
                    if (typeof (/** @type {any} */ (this).onopen) === "function") {
                        /** @type {any} */ (this).onopen({ target: this, currentTarget: this });
                    }
                    onopenSucceeded = true;
                } catch (_) {
                    /* swallow game onopen errors */
                }
                if (onopenSucceeded && typeof hooks.onWebSocketOpen === "function") {
                    try {
                        hooks.onWebSocketOpen(this);
                    } catch (_) {
                        /* swallow */
                    }
                }
            }, 10);
        }
        send(data) {
            let bytes;
            try {
                bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
            } catch (_) {
                return;
            }
            if (typeof hooks.onWebSocketSend === "function") {
                try {
                    hooks.onWebSocketSend(bytes);
                } catch (_) {
                    /* swallow */
                }
            }
        }
        close() {
            this.readyState = 3;
        }
        addEventListener(t, fn) {
            this["on" + t] = fn;
        }
        removeEventListener() {}
    }
    MockWebSocket.OPEN = 1;
    MockWebSocket.CLOSED = 3;
    MockWebSocket.CONNECTING = 0;

    // P12: Stateless parts of the Proxy handler are shared across all
    // sandboxes. Only the `set` trap needs the per-call hooks; we get
    // them from a closure-bound variable set by `withHooks`. This avoids
    // re-creating the same handler literal on every createZorrSandbox()
    // call (~1-2ms saved per call).
    let _activeHooks = hooks;
    const SHARED_PROXY_HANDLER = {
        get(target, prop) {
            if (prop === Symbol.toPrimitive) return () => "";
            if (prop === Symbol.iterator) return function* () {};
            if (prop === "prototype") return {};
            if (prop === "__proto__") return Object.prototype;
            if (prop === "then") return undefined;
            if (prop in target) return target[prop];
            return new Proxy(function () {}, SHARED_PROXY_HANDLER);
        },
        set(target, prop, val) {
            target[prop] = val;
            if (typeof _activeHooks.onGlobalSet === "function") {
                try {
                    _activeHooks.onGlobalSet(prop, val);
                } catch (_) {}
            }
            return true;
        },
        apply() {
            return new Proxy({}, SHARED_PROXY_HANDLER);
        },
        construct() {
            return new Proxy({}, SHARED_PROXY_HANDLER);
        },
        deleteProperty(target, prop) {
            delete target[prop];
            return true;
        },
    };
    const mockObj = () => new Proxy({}, SHARED_PROXY_HANDLER);
    const mockAny = () => new Proxy(function () {}, SHARED_PROXY_HANDLER);

    // Track Array.prototype.push calls (best-effort; the game may use
    // direct array indexing which we cannot detect here)
    const origArrayPush = Array.prototype.push;
    let arrayPatched = false;
    if (typeof hooks.onArrayPush === "function") {
        Array.prototype.push = function patchedPush(...args) {
            for (const item of args) {
                try {
                    hooks.onArrayPush(this, item);
                } catch (_) {}
            }
            return origArrayPush.apply(this, args);
        };
        arrayPatched = true;
    }
    // Track Map.prototype.set calls (game uses b4() which is its own
    // constructor, not Map, but normal Map.set is useful for VARIANTS
    // detected through other paths)
    const origMapSet = Map.prototype.set;
    let mapPatched = false;
    if (typeof hooks.onMapSet === "function") {
        Map.prototype.set = function patchedSet(key, value) {
            try {
                hooks.onMapSet(this, key, value);
            } catch (_) {}
            return origMapSet.call(this, key, value);
        };
        mapPatched = true;
    }

    // Track DataView.prototype.setUint32 calls to capture protocol version
    // directly from the handshake construction code, even when the game's
    // onopen handler throws before calling WebSocket.send().
    const origDataViewSetUint32 = DataView.prototype.setUint32;
    let dataViewPatched = false;
    if (typeof hooks.onDataViewSetUint32 === "function") {
        DataView.prototype.setUint32 = function patchedSetUint32(byteOffset, value, littleEndian) {
            try {
                hooks.onDataViewSetUint32(byteOffset, value, this);
            } catch (_) {}
            return origDataViewSetUint32.call(this, byteOffset, value, littleEndian);
        };
        dataViewPatched = true;
    }

    // P4: cleanup functions to restore prototypes (prevent permanent side effects)
    // cleanupPartial: restore Array/Map immediately (no longer needed post-VM)
    // cleanup: also restore DataView AFTER the handshake wait completes
    const cleanupPartial = () => {
        if (arrayPatched) {
            Array.prototype.push = origArrayPush;
            arrayPatched = false;
        }
        if (mapPatched) {
            Map.prototype.set = origMapSet;
            mapPatched = false;
        }
    };
    const cleanup = () => {
        cleanupPartial();
        if (dataViewPatched) {
            DataView.prototype.setUint32 = origDataViewSetUint32;
            dataViewPatched = false;
        }
    };

    const sandbox = {
        Object,
        Array,
        String,
        Number,
        Boolean,
        Function,
        Symbol,
        RegExp,
        Error,
        TypeError,
        RangeError,
        SyntaxError,
        ReferenceError,
        URIError,
        EvalError,
        Map,
        Set,
        WeakMap,
        WeakSet,
        Proxy,
        Reflect,
        Promise,
        Math,
        Date,
        // Tolerant JSON: the game passes custom/non-standard data
        // (e.g. tuples like ["Common", "#7EEF6D", 40]) which are not
        // valid JSON. Returning a dummy object lets the script
        // continue past the failure.
        JSON: {
            parse: (s, reviver) => {
                try {
                    return JSON.parse(s, reviver);
                } catch (_) {
                    return null;
                }
            },
            stringify: JSON.stringify,
        },
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        NaN,
        Infinity,
        undefined,
        Uint8Array,
        Uint16Array,
        Uint32Array,
        Int8Array,
        Int16Array,
        Int32Array,
        Float32Array,
        Float64Array,
        ArrayBuffer,
        DataView,
        SharedArrayBuffer: ArrayBuffer,
        Uint8ClampedArray,
        TextDecoder,
        TextEncoder,
        URL,
        URLSearchParams,
        console: {
            log() {},
            warn() {},
            error() {},
            info() {},
            debug() {},
            dir() {},
            trace() {},
        },
        setTimeout: (fn, ms) => {
            try {
                const id = setTimeout(() => {
                    try {
                        fn();
                    } catch (_) {
                        /* swallow game timer errors */
                    }
                }, ms);
                if (id && typeof id.unref === "function") id.unref();
                return id;
            } catch (_) {
                return 0;
            }
        },
        clearTimeout,
        setInterval: (fn, ms) => {
            try {
                const id = setInterval(() => {
                    try {
                        fn();
                    } catch (_) {
                        /* swallow game timer errors */
                    }
                }, ms);
                if (id && typeof id.unref === "function") id.unref();
                return id;
            } catch (_) {
                return 0;
            }
        },
        clearInterval,
        atob: (s) => Buffer.from(s, "base64").toString("binary"),
        btoa: (s) => Buffer.from(s, "binary").toString("base64"),
        encodeURIComponent,
        encodeURI,
        // Tolerant decoders: the game source sometimes passes malformed
        // inputs to decodeURI/decodeURIComponent, which would throw
        // URIError and abort the whole VM run. Return an empty string
        // for un-decodable inputs so the script continues.
        decodeURIComponent: (s) => {
            try {
                return decodeURIComponent(s);
            } catch (_) {
                return "";
            }
        },
        decodeURI: (s) => {
            try {
                return decodeURI(s);
            } catch (_) {
                return s;
            }
        },
        WebSocket: MockWebSocket,
        document: mockObj(),
        navigator: mockObj(),
        history: mockObj(),
        screen: mockObj(),
        location: {
            href: "https://zorr.pro/",
            hostname: "zorr.pro",
            pathname: "/",
            search: "",
            hash: "",
            origin: "https://zorr.pro",
            protocol: "https:",
            reload() {},
            assign() {},
            replace() {},
        },
        localStorage: {
            getItem() {
                return null;
            },
            setItem() {},
            removeItem() {},
            clear() {},
        },
        sessionStorage: {
            getItem() {
                return null;
            },
            setItem() {},
            removeItem() {},
            clear() {},
        },
        performance: {
            now() {
                return Date.now();
            },
            mark() {},
            measure() {},
            getEntriesByType() {
                return [];
            },
        },
        CanvasRenderingContext2D: mockAny(),
        WebGLRenderingContext: mockAny(),
        WebGL2RenderingContext: mockAny(),
        OffscreenCanvas: mockAny(),
        Path2D: mockAny(),
        ImageData: class {
            constructor(w, h) {
                this.width = w;
                this.height = h;
                this.data = new Uint8ClampedArray(w * h * 4);
            }
        },
        HTMLElement: mockAny(),
        HTMLCanvasElement: mockAny(),
        HTMLImageElement: mockAny(),
        HTMLVideoElement: mockAny(),
        HTMLAudioElement: mockAny(),
        HTMLInputElement: mockAny(),
        HTMLDivElement: mockAny(),
        SVGElement: mockAny(),
        Element: mockAny(),
        Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9 },
        DocumentFragment: mockAny(),
        DOMParser: class {
            parseFromString() {
                return mockObj();
            }
        },
        Event: class {
            constructor(t) {
                this.type = t;
            }
            preventDefault() {}
            stopPropagation() {}
        },
        CustomEvent: class {
            constructor(t, o) {
                this.type = t;
                this.detail = o?.detail;
            }
        },
        PointerEvent: mockAny(),
        MouseEvent: mockAny(),
        KeyboardEvent: mockAny(),
        TouchEvent: mockAny(),
        WheelEvent: mockAny(),
        ResizeObserver: class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
        MutationObserver: class {
            observe() {}
            disconnect() {}
        },
        IntersectionObserver: class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
        Image: class {
            set src(v) {}
            get src() {
                return "";
            }
        },
        Audio: class {
            play() {
                return Promise.resolve();
            }
            pause() {}
        },
        AudioContext: mockAny(),
        requestAnimationFrame: (cb) => setTimeout(cb, 16),
        cancelAnimationFrame: (id) => clearTimeout(id),
        fetch: () =>
            Promise.resolve({
                ok: true,
                json() {
                    return Promise.resolve({});
                },
                text() {
                    return Promise.resolve("");
                },
                arrayBuffer() {
                    return Promise.resolve(new ArrayBuffer(0));
                },
            }),
        XMLHttpRequest: mockAny(),
        Worker: mockAny(),
        Blob: class {},
        FileReader: mockAny(),
        FormData: mockAny(),
        Headers: mockAny(),
        AbortController: class {
            constructor() {
                this.signal = {};
            }
            abort() {}
        },
        CSS: {
            supports() {
                return false;
            },
        },
        crypto: {
            randomUUID() {
                return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
                    const r = (Math.random() * 16) | 0;
                    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
                });
            },
            getRandomValues(a) {
                for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
                return a;
            },
            subtle: mockObj(),
        },
        alert() {},
        confirm() {
            return false;
        },
        prompt() {
            return "";
        },
        open() {
            return mockObj();
        },
        close() {},
        focus() {},
        blur() {},
        print() {},
        scrollTo() {},
        scrollBy() {},
        getComputedStyle() {
            return mockObj();
        },
        matchMedia() {
            return { matches: false, addEventListener() {}, removeEventListener() {} };
        },
        getSelection() {
            return {
                toString() {
                    return "";
                },
            };
        },
        postMessage() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {},
        innerWidth: 1920,
        innerHeight: 1080,
        outerWidth: 1920,
        outerHeight: 1080,
        devicePixelRatio: 1,
        onbeforeunload: null,
        onerror: null,
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.top = sandbox;
    sandbox.parent = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.frames = sandbox;

    const ctx = vm.createContext(sandbox);

    function runScript(src, opts = {}) {
        const scriptOpts = { filename: opts.filename || "zorr.js" };
        // Suppress unhandled rejections from game code async callbacks
        // (e.g. fetch().then() chains that throw inside the sandbox)
        const _rejectHandler = () => {};
        process.on("unhandledRejection", _rejectHandler);
        try {
            new vm.Script(src, scriptOpts).runInContext(ctx, { timeout: opts.timeout || 30000 });
        } catch (_) {
            // partial execution is expected; ignore
        }
        // Allow pending microtasks to settle, then restore
        const _cleanupTimer = setTimeout(() => {
            process.removeListener("unhandledRejection", _rejectHandler);
        }, 500);
        if (_cleanupTimer && typeof _cleanupTimer.unref === "function") _cleanupTimer.unref();
    }

    function captureFromGlobal(key) {
        try {
            return vm.runInContext(`globalThis.${key}`, ctx);
        } catch (_) {
            return undefined;
        }
    }

    return { sandbox, ctx, MockWebSocket, runScript, captureFromGlobal, cleanup, cleanupPartial };
}

export { createZorrSandbox };
