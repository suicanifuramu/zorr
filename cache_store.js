/**
 * cache_store.js
 *
 * Persistent on-disk cache for the extraction pipeline result.
 *
 * "ローカルフリー" interpretation: We do NOT persist the raw source code
 * (or any form of it) on disk — that is fetched live from zorr.pages.dev
 * every time the in-process cache is invalidated. The on-disk cache holds
 * the *extracted/normalized* v2 schema only, so a process restart can
 * pick up where it left off without re-running the VM.
 *
 * The cache file is:
 *   - Plain JSON, UTF-8 encoded
 *   - Stored at <project>/websocket/.extraction_cache.json
 *   - Validated by (schemaVersion, jsUrl) on load
 *
 * No encryption/signing is required for this use case (the data is
 * public game data), but we keep the file under gitignore-equivalent
 * handling and write atomically via temp + rename.
 */
import fs from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";
const CACHE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(CACHE_DIR, ".extraction_cache.json");
const CACHE_TMP = CACHE_PATH + ".tmp";

const SCHEMA_VERSION = 5;

function loadCache() {
    let raw;
    try {
        raw = fs.readFileSync(CACHE_PATH, "utf8");
    } catch (e) {
        if (e.code !== "ENOENT") {
            if (process.env.ZORR_DEBUG) console.error(`[cache_store] read failed: ${e.message}`);
        }
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        if (process.env.ZORR_DEBUG) console.error(`[cache_store] parse failed: ${e.message}`);
        return null;
    }
    if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
    if (typeof parsed.jsUrl !== "string") return null;
    if (typeof parsed.fetchedAt !== "string") return null;
    if (
        !Array.isArray(parsed.rarities) ||
        !Array.isArray(parsed.variants) ||
        !Array.isArray(parsed.petals) ||
        !Array.isArray(parsed.mobs)
    )
        return null;
    // talents are optional in v4 (warn-only validation upstream)
    return parsed;
}

function saveCache(result) {
    if (!result || typeof result !== "object") return false;
    if (result.schemaVersion !== undefined && result.schemaVersion !== SCHEMA_VERSION) return false;
    const slim = {
        schemaVersion: SCHEMA_VERSION,
        jsUrl: result.jsUrl,
        htmlUrl: result.htmlUrl,
        fetchedAt: result.fetchedAt,
        protocolVersion: result.protocolVersion ?? null,
        vmRunMs: result.vmRunMs ?? 0,
        rarities: result.rarities,
        variants: result.variants,
        petals: result.petals,
        mobs: result.mobs,
        talents: result.talents ?? [],
        biomeMobs: result.biomeMobs ?? {},
        regions: result.regions ?? [],
        biomes: result.biomes ?? [],
        snakeMobIndices: result.snakeMobIndices ?? [],
        snakeMethod: result.snakeMethod ?? "none",
    };
    let json;
    try {
        json = JSON.stringify(slim);
    } catch (e) {
        if (process.env.ZORR_DEBUG) console.error(`[cache_store] stringify failed: ${e.message}`);
        return false;
    }
    try {
        fs.writeFileSync(CACHE_TMP, json);
        fs.renameSync(CACHE_TMP, CACHE_PATH);
        return true;
    } catch (e) {
        if (process.env.ZORR_DEBUG) console.error(`[cache_store] write failed: ${e.message}`);
        try {
            fs.unlinkSync(CACHE_TMP);
        } catch (_) {
            /* best effort */
        }
        return false;
    }
}

function clearCache() {
    try {
        fs.unlinkSync(CACHE_PATH);
        return true;
    } catch (_) {
        return false;
    }
}

function cacheExists() {
    try {
        fs.accessSync(CACHE_PATH);
        return true;
    } catch (_) {
        return false;
    }
}

function cachePath() {
    return CACHE_PATH;
}

export { loadCache };
export { saveCache };
export { clearCache };
export { cacheExists };
export { cachePath };
export { SCHEMA_VERSION };
