/**
 * game_data_extractor.js
 *
 * Public facade for the unified extraction pipeline.
 *
 * The actual fetch + VM + classify work lives in extraction_pipeline.js. This file provides:
 *   - extractGameData() — the legacy public API, returns the v2 schema
 *   - the v2 schema normalizers (re-exported from normalizers.js)
 */
import { getOrComputeExtraction, runFullExtraction, extractSnakeIndicesFromRaw } from "./extraction_pipeline.js";
import {
    slugify,
    normalizeRarities,
    normalizeVariants,
    normalizePetals,
    normalizeMobs,
    normalizeTalents,
    computeSnakeIndices,
} from "./normalizers.js";

// ============================================================================
// Public API: extractGameData(opts) -> v2 schema
// ============================================================================
/**
 * @param {Object} [options]
 * @param {number} [options.timeout=30000]
 * @param {number} [options.retries=2]
 * @param {boolean} [options.includeProtocol=true]  wait for handshake (default true; small cost, ensures protocolVersion is always populated)
 * @param {boolean} [options.includeSource=false]  if true, include the raw JS source in result._source (P1; used by pinky detection)
 * @returns {Promise<{
 *   schemaVersion: 2,
 *   extractedAt: string,
 *   sourceUrl: string,
 *   protocolVersion: number,
 *   vmRunMs: number,
 *   rarities: Array,
 *   variants: Array,
 *   petals: Array,
 *   mobs: Array,
 *   talents: Array,
 *   regions: Array<{id, name, slug}>,
 *   biomes: Array<{id, name, slug, color}>,
 *   snakeMobIndices: number[],
 *   snakeMethod: string,
 *   _source?: string,
 * }>}
 */
async function extractGameData({ timeout = 30000, retries = 2, includeProtocol = true, includeSource = false } = {}) {
    const full = await getOrComputeExtraction({ timeout, retries, includeProtocol, includeSource });
    return {
        schemaVersion: 2,
        extractedAt: full.fetchedAt,
        sourceUrl: full.jsUrl,
        protocolVersion: full.protocolVersion ?? 444,
        vmRunMs: full.vmRunMs,
        rarities: full.rarities,
        variants: full.variants,
        petals: full.petals,
        mobs: full.mobs,
        talents: full.talents || [],
        regions: full.regions || [],
        biomes: full.biomes || [],
        snakeMobIndices: full.snakeMobIndices,
        snakeMethod: full.snakeMethod,
        ...(includeSource && full.source ? { _source: full.source } : {}),
    };
}

export { extractGameData };
export { runFullExtraction };
export { extractSnakeIndicesFromRaw };
export { normalizeRarities };
export { normalizeVariants };
export { normalizePetals };
export { normalizeMobs };
export { normalizeTalents };
export { computeSnakeIndices };
export { slugify };
