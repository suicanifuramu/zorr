/**
 * extraction_pipeline.js
 *
 * Unified fetch + VM extraction pipeline — public orchestrator.
 *
 * Stage machinery (fetch, AST, VM, handshake) lives in lib/pipeline/stages.js;
 * this file owns runFullExtraction assembly, the cache layers, and the
 * getOrComputeExtraction coalescing entry point.
 *
 * In-process cache (TTL = Infinity by default) coalesces concurrent
 * and sequential calls, ensuring only one HTTPS fetch + one VM run
 * per process per (source URL, forced refresh) pair.
 */
import {
    _fetchStage,
    _parseAndInject,
    _scanSourceForVersion,
    _buildTxResolver,
    _resolveDynamicResolver,
    _parseRootAst,
    _runVmStage,
    _waitForHandshake,
} from "./lib/pipeline/stages.js";
import { extractSnakeIndicesFromRaw } from "./lib/pipeline/snake.js";
import {
    normalizeRarities,
    normalizeVariants,
    normalizePetals,
    normalizeMobs,
    normalizeTalents,
    normalizeBiomeMobs,
    normalizeServerList,
    computeSnakeIndices,
} from "./normalizers.js";
import _talentData from "./talent_data.js";
import * as acorn from "acorn";
import * as cacheStore from "./cache_store.js";
import { fetchJsUrlFromHtml } from "./source_fetcher.js";

// ============================================================================
// Cache + in-flight coalescing
// ============================================================================
let _cached = null; // { result, expiresAt, jsUrl }
let _inflight = null; // Promise<result>
let _lastJsUrl = null; // jsUrl of the currently cached extraction
let _lastUrlCheckMs = 0; // timestamp of last URL check
let _lastUrlChangeMs = 0; // timestamp of last detected URL change
let _urlCheckTimer = null; // P7: background interval handle

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
                // Invalidate ALL cache layers. The disk cache must go too —
                // otherwise the next getOrComputeExtraction re-accepts the
                // stale disk entry (its acceptance check passes when
                // _lastJsUrl is null) and the process never re-extracts.
                _cached = null;
                _lastJsUrl = null;
                cacheStore.clearCache();
            }
        } catch (e) {
            // Network blip: keep the cached value, retry next tick
            if (process.env.ZORR_DEBUG) {
                console.error(`[cache] URL check failed: ${e.message}`);
            }
        }
    }, URL_CHECK_INTERVAL_MS);
    if (typeof _urlCheckTimer.unref === "function") _urlCheckTimer.unref();
}

/**
 * Return a snapshot of the current cache state (for diagnostics / /config/refresh etc.).
 * @returns {{cached: boolean, jsUrl: string|null, fetchedAt: string|null, age: number, lastCheck: number, lastChange: number, diskCached: boolean, diskPath: string}}
 */
function getCacheStatus() {
    return {
        cached: _cached !== null,
        jsUrl: _lastJsUrl,
        fetchedAt: _cached?.result?.fetchedAt ?? null,
        age: _cached ? Date.now() - new Date(_cached.result.fetchedAt).getTime() : 0,
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
 *   talents: Array,
 *   biomeMobs: Object,
 *   regions: Array,
 *   biomes: Array,
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
        injected,
        candidates,
        timeout,
    });

    // Validate classification completeness (4 core kinds are required)
    if (!classified.rarity || !classified.variant || !classified.petal || !classified.mob) {
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
        if (typeof v === "function") {
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
                    node.init &&
                    node.init.type === "Identifier" &&
                    !callResolver.has(node.id.name)
                ) {
                    const target = callResolver.get(node.init.name);
                    if (typeof target === "function") {
                        callResolver.set(node.id.name, target);
                        added = true;
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
            /* parse error stops alias expansion */
        }
    }
    if (process.env.ZORR_DEBUG)
        console.log(
            `[debug] callResolver keys:`,
            Array.from(callResolver.keys()),
            "Od captured:",
            callResolver.has("Od")
        );
    _resolveDynamicResolver(txResolver, callResolver);
    const rootAst = _parseRootAst(source);
    const { regions, biomes, functionName } = normalizeServerList(rootAst, txResolver, callResolver);
    if (regions.length === 0 && biomes.length === 0) {
        console.log(
            `\x1b[33m[warn] server-list tabs not found in AST; map.html will show empty region/biome dropdowns\x1b[0m`
        );
    } else {
        console.log(
            `\x1b[36m[extraction] server-list: ${regions.length} regions, ${biomes.length} biomes (function: ${functionName || "?"})\x1b[0m`
        );
    }

    // Stage 4: handshake wait (one-shot, with hard cap)
    let { protocolVersion } = await _waitForHandshake(getHandshakeState, { includeProtocol, handshakeMaxWaitMs });

    // Now safe to restore DataView.prototype.setUint32 (the handshake
    // wait is complete; the game's onopen has already fired).
    if (typeof deferredCleanup === "function") deferredCleanup();

    // Stage 4b: static source scan fallback if handshake didn't yield a version
    if (protocolVersion === null && includeProtocol) {
        const scannedVersion = _scanSourceForVersion(source);
        if (scannedVersion !== null) {
            protocolVersion = scannedVersion;
            if (process.env.ZORR_DEBUG)
                console.log(`[extraction] protocol version from source scan: ${protocolVersion}`);
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
            while (jsonStart > 0 && source[jsonStart] !== "{") jsonStart--;
            // Walk forward to find the matching closing braces
            let depth = 0;
            let jsonEnd = jsonStart;
            while (jsonEnd < source.length) {
                if (source[jsonEnd] === "{") depth++;
                else if (source[jsonEnd] === "}") {
                    depth--;
                    if (depth === 0) {
                        jsonEnd++;
                        break;
                    }
                }
                jsonEnd++;
            }
            const rawJson = source.substring(jsonStart, jsonEnd);
            try {
                biomeMobs = normalizeBiomeMobs(JSON.parse(rawJson));
            } catch (_) {
                /* ignore parse error */
            }
        }
        if (process.env.ZORR_DEBUG) {
            console.log(`[biomeMobs-fallback] keys=${Object.keys(biomeMobs).length}`);
        }
    }
    const snakeMobIndices = computeSnakeIndices(mobs);

    // The two detection methods should agree. If they don't, prefer
    // the property-based detection (rawSnakeIndices) as authoritative.
    const agreement =
        rawSnakeIndices.length === snakeMobIndices.length && rawSnakeIndices.every((v, i) => v === snakeMobIndices[i]);
    const finalSnakeIndices = agreement ? snakeMobIndices : rawSnakeIndices;
    const snakeMethod = finalSnakeIndices.length > 0 ? (agreement ? "snakeCount+isSnake" : "snakeCount") : "none";

    // P2: source is conditionally included. Internally, we keep `source`
    // available on the cache so a later `includeSource: true` call can
    // reuse the same fetch without re-hitting the network.
    return {
        source,
        jsUrl,
        htmlUrl,
        protocolVersion,
        rarities,
        variants,
        petals,
        mobs,
        talents,
        biomeMobs,
        snakeMobIndices: finalSnakeIndices,
        snakeMethod,
        regions,
        biomes,
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
 * @param {number} [options.timeout=30000]  VM stage timeout (ms)
 * @param {number} [options.retries=2]  fetch retry count
 * @param {boolean} [options.includeProtocol=true]  wait for handshake (protocol version)
 * @param {number} [options.handshakeMaxWaitMs=3000]  handshake wait cap (ms)
 * @returns {Promise<{source: string, jsUrl: string, htmlUrl: string, protocolVersion: number, rarities: Array, variants: Array, petals: Array, mobs: Array, talents: Array, biomeMobs: Object, regions: Array, biomes: Array, snakeMobIndices: number[], snakeMethod: string, vmRunMs: number, fetchedAt: string}>}
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
    const project = (full) =>
        includeSource
            ? full
            : (() => {
                  const { source, ...rest } = full;
                  return rest;
              })();

    // 1. In-process memory cache hit
    if (_cached && (_cached.expiresAt === Infinity || Date.now() < _cached.expiresAt)) {
        // P7: URL-change probe is now background-driven via setInterval
        // (started lazily on first cache hit). Per-call latency is
        // therefore not affected by the URL check at all.
        if (!skipUrlCheck) _ensureUrlCheckTimer();
        if (process.env.ZORR_DEBUG) _logCacheLoad("memory", _lastJsUrl);
        return project(_cached.result);
    }

    // 2. Coalesce concurrent calls
    if (_inflight) return _inflight.then(project);

    // 3. P11: On-disk cache (skip if source is requested — disk cache
    // does not store the raw source)
    if (!skipDiskCache && !includeSource) {
        const disk = cacheStore.loadCache();
        if (disk) {
            // Validate the disk cache against the current known jsUrl. When
            // _lastJsUrl is null (fresh process), the URL is verified with a
            // single cheap HTML check before accepting — a stale disk cache
            // from a previous run must not mask a game update. On network
            // failure the disk cache is still accepted (best effort).
            let matches = !_lastJsUrl || disk.jsUrl === _lastJsUrl;
            if (matches && !_lastJsUrl && !skipUrlCheck) {
                try {
                    const live = await fetchJsUrlFromHtml();
                    if (live.jsUrl !== disk.jsUrl) {
                        _logUrlChange(disk.jsUrl, live.jsUrl);
                        matches = false;
                        _lastJsUrl = live.jsUrl; // remember so later checks compare correctly
                    }
                } catch (_) {
                    /* network blip: accept disk cache as before */
                }
            }
            if (matches) {
                _cached = {
                    result: { ...disk, source: "" },
                    expiresAt: ttlMs === Infinity ? Infinity : Date.now() + ttlMs,
                };
                if (!_lastJsUrl) _lastJsUrl = disk.jsUrl;
                _logCacheLoad("disk", disk.jsUrl);
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

export { runFullExtraction };
export { getOrComputeExtraction };
export { invalidateCache };
export { getCacheStatus };
export { extractSnakeIndicesFromRaw };
export { URL_CHECK_INTERVAL_MS };
export { _buildTxResolver } from "./lib/pipeline/stages.js";
export { _parseRootAst } from "./lib/pipeline/stages.js";
export { _resolveDynamicResolver } from "./lib/pipeline/stages.js";
export { _scanSourceForVersion } from "./lib/pipeline/stages.js";
