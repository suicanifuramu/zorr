/**
 * shape_classifier.js
 *
 * Classifies a captured runtime value as one of the Zorr game data kinds:
 *   - rarity           : array of [name, color, weight] tuples (~10 entries)
 *   - variant          : Map-like object (M({...}) result) with ~18 variant names
 *   - petal            : array of objects with name/desc/health/damage (~500+)
 *   - mob              : array of objects with name/desc/health/damage/armor (~100-300)
 *   - none             : doesn't match any of the above
 *
 * Also provides detectSnakeProp() which inspects a raw mob object and
 * returns the property that marks it as a snake-type mob. Phase A
 * verification on 2026-06-06 confirmed that `snakeCount` is the
 * authoritative property in the live game source (9/178 mobs have it,
 * with values 3-15, paired with `snakeHeight`).
 *
 * Note: server list (regions/biomes) is now extracted statically from
 * the tU function body (see normalizers.normalizeServerList). The
 * earlier `new tU()` runtime-capture approach was abandoned because
 * the constructor depends on DOM/window globals (gr/hp/tw/tz/O5) that
 * can't be mocked safely in the sandbox.
 */
const SNAKE_PROP_NAMES = [
    "snakeCount",
    "snakeBodyCount",
    "bodyPartCount",
    "segmentCount",
    "segments",
    "bodyParts",
    "serpentLength",
];

function isVariantMap(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
    // Count numeric-indexed string entries via Object.keys() instead
    // of relying on obj.length which may be stale (e.g. the game adds
    // entries post-construction without updating .length).
    let count = 0;
    for (const k of Object.keys(obj)) {
        if (/^\d+$/.test(k) && typeof obj[k] === "string") count++;
    }
    return count >= 15;
}

function isRarityTupleArray(items) {
    if (!Array.isArray(items) || items.length < 3 || items.length > 30) return false;
    const first = items[0];
    if (!Array.isArray(first) || first.length < 3) return false;
    if (typeof first[0] !== "string") return false;
    if (typeof first[1] !== "string" || !/^#[0-9a-f]{6}$/i.test(first[1])) return false;
    if (typeof first[2] !== "number") return false;
    return true;
}

function isPetalArray(items) {
    if (!Array.isArray(items) || items.length < 50) return false;
    const first = items[0];
    if (!first || typeof first !== "object" || Array.isArray(first)) return false;
    // Petal: has name (string) and desc (string). No maxHealth (obfuscated
    // to single char) and no "egg" (mob-specific).
    if (typeof first.name !== "string") return false;
    if (typeof first.desc !== "string" && typeof first.description !== "string") return false;
    if (first.egg) return false;
    return true;
}

function isMobArray(items) {
    if (!Array.isArray(items) || items.length < 10) return false;
    const first = items[0];
    if (!first || typeof first !== "object" || Array.isArray(first)) return false;
    if (typeof first.name !== "string") return false;
    if (!("health" in first) && !("maxHealth" in first)) return false;
    if (first.desc === undefined && first.description === undefined) return false;
    return true;
}

function isBiomeMobMap(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
    const keys = Object.keys(obj);
    if (keys.length < 3) return false;
    for (const k of keys) {
        const v = obj[k];
        if (!v || typeof v !== "object" || Array.isArray(v)) return false;
        const vKeys = Object.keys(v);
        if (vKeys.length < 3) return false;
        if (!vKeys.every((vk) => typeof v[vk] === "number")) return false;
    }
    return true;
}

/**
 * Detect whether a raw mob object has a snake-type indicator and
 * return the property that flagged it. Used by extraction_pipeline
 * to compute snakeMobIndices from raw mob data (the normalizer may
 * drop the snakeCount property).
 *
 * @param {Object} mob
 * @returns {{propName: string, value: number}|null}
 */
function detectSnakeProp(mob) {
    if (!mob || typeof mob !== "object") return null;
    for (const name of SNAKE_PROP_NAMES) {
        if (!(name in mob)) continue;
        const v = mob[name];
        if (typeof v === "number" && v > 0) {
            return { propName: name, value: v };
        }
    }
    return null;
}

/**
 * Classify a value. Returns {kind, items} or null if no match.
 * For rarity arrays, items is the array. For variant maps, items is
 * the object. For petal/mob arrays, items is the array.
 */
function classify(value) {
    if (value == null) return null;
    if (isVariantMap(value)) {
        return { kind: "variant", items: value };
    }
    if (isRarityTupleArray(value)) {
        return { kind: "rarity", items: value };
    }
    if (isPetalArray(value)) {
        return { kind: "petal", items: value };
    }
    if (isMobArray(value)) {
        return { kind: "mob", items: value };
    }
    if (isBiomeMobMap(value)) {
        return { kind: "biomeMobs", items: value };
    }
    return null;
}

export { classify };
export { isVariantMap };
export { isRarityTupleArray };
export { isPetalArray };
export { isMobArray };
export { isBiomeMobMap };
export { detectSnakeProp };
export { SNAKE_PROP_NAMES };
