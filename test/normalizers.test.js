"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const {
    slugify,
    normalizeRarities,
    normalizeVariants,
    normalizePetals,
    normalizeMobs,
    normalizeTalents,
    normalizeBiomeMobs,
    computeSnakeIndices,
} = require("../normalizers");
const {
    isVariantMap,
    isRarityTupleArray,
    isPetalArray,
    isMobArray,
    isBiomeMobMap,
    detectSnakeProp,
    classify,
    SNAKE_PROP_NAMES,
} = require("../shape_classifier");
const { SNAKE_SLUG_PATTERNS, isSnakeSlug } = require("../game_data_extractor");
const { extractSnakeIndicesFromRaw } = require("../extraction_pipeline");

test("slugify lowercases and underscores", () => {
    assert.strictEqual(slugify("Hel Beetle"), "hel_beetle");
    assert.strictEqual(slugify("Rock (Hard)"), "rock_hard"); // spaces -> _, other non-word chars removed
    assert.strictEqual(slugify("  A  B  "), "_a_b_"); // whitespace collapses to single _
    assert.strictEqual(slugify(42), "");
});

test("normalizeRarities maps to schema (tuple or object form)", () => {
    const out = normalizeRarities([
        { id: 1, name: "Common", color: "#fff", craftRate: 10 },
        ["Uncommon", "#0f0", 5], // raw tuple form
    ]);
    assert.deepStrictEqual(out[0], { id: 1, name: "Common", color: "#fff", weight: 10, slug: "common" });
    assert.deepStrictEqual(out[1], { id: 1, name: "Uncommon", color: "#0f0", weight: 5, slug: "uncommon" });
    assert.strictEqual(out.length, 2);
});

test("normalizeVariants returns array keyed by numeric index", () => {
    const out = normalizeVariants({ 3: "Golden", 7: "Shiny", 8: "Golden" }); // dedup by name
    assert.deepStrictEqual(out, [
        { id: 3, name: "Golden" },
        { id: 7, name: "Shiny" },
    ]);
});

test("normalizePetals maps core fields", () => {
    const p = normalizePetals([
        { id: 5, name: "Rose", desc: "heals", size: 2, damage: 3, health: 4, reload: 5, cost: 6 },
    ]);
    assert.deepStrictEqual(p[0], {
        id: 5,
        name: "Rose",
        slug: "rose",
        desc: "heals",
        size: 2,
        damage: 3,
        health: 4,
        reload: 5,
        cost: 6,
    });
});

test("normalizeMobs flags snakes via detectSnakeProp", () => {
    const mobs = [
        { id: 1, name: "Centipede", health: 10, damage: 2, armor: 0, size: 5, snakeCount: 3 },
        { id: 2, name: "Bee", health: 1, damage: 1, armor: 0, size: 1 },
    ];
    const out = normalizeMobs(mobs);
    assert.strictEqual(out[0].isSnake, true);
    assert.strictEqual(out[0].snakeProp, "snakeCount");
    assert.strictEqual(out[0].snakeCount, 3);
    assert.strictEqual(out[1].isSnake, false);
    assert.strictEqual(out[1].snakeProp, null);
    assert.strictEqual(out[1].snakeCount, null);
});

test("normalizeTalents requires slug, defaults parentId -1", () => {
    const t = normalizeTalents([
        { id: 9, slug: "sharper", cost: 3, value: 5, parentId: 2 },
        { id: 10, name: "no-slug" },
    ]);
    assert.deepStrictEqual(t[0], { id: 9, slug: "sharper", cost: 3, value: 5, parentId: 2 });
    assert.strictEqual(t.length, 1); // missing slug filtered out
});

test("normalizeBiomeMobs expects mob-set objects, not arrays", () => {
    assert.deepStrictEqual(
        normalizeBiomeMobs({
            plains: { bee: 1, beetle: 2 },
            desert: { scorpion: 3 },
        }),
        { plains: ["bee", "beetle"], desert: ["scorpion"] }
    );
    assert.deepStrictEqual(normalizeBiomeMobs(null), {});
});

test("computeSnakeIndices returns isSnake positions", () => {
    const mobs = [{ isSnake: false }, { isSnake: true }, { isSnake: true }];
    assert.deepStrictEqual(computeSnakeIndices(mobs), [1, 2]);
});

test("shape classifier predicate helpers", () => {
    const variantMap = {};
    for (let i = 0; i < 15; i++) variantMap[i] = "v" + i;
    assert.strictEqual(isVariantMap(variantMap), true);
    assert.strictEqual(isVariantMap({ 1: "a" }), false); // needs >= 15 entries
    assert.strictEqual(isVariantMap(["a"]), false);
    const rarityTuples = [];
    for (let i = 0; i < 5; i++) rarityTuples.push(["Common", "#aabbcc", 10]);
    assert.strictEqual(isRarityTupleArray(rarityTuples), true);
    assert.strictEqual(isRarityTupleArray([["Common", "#aabbcc", 10]]), false); // too few
    const petals = [];
    for (let i = 0; i < 50; i++) petals.push({ id: i, name: "Petal", desc: "d" });
    assert.strictEqual(isPetalArray(petals), true);
    assert.strictEqual(isPetalArray(petals.slice(0, 49)), false); // min 50
    const mobs = [];
    for (let i = 0; i < 10; i++) mobs.push({ id: i, name: "Mob", health: 5, desc: "a mob", egg: true });
    assert.strictEqual(isMobArray(mobs), true);
    assert.strictEqual(isMobArray(mobs.slice(0, 9)), false); // min 10
    assert.strictEqual(isBiomeMobMap({ plains: [] }), false); // needs >= 3 biomes
    assert.strictEqual(
        isBiomeMobMap({ a: { x: 1, y: 2, z: 3 }, b: { x: 1, y: 2, z: 3 }, c: { x: 1, y: 2, z: 3 } }),
        true
    );
});

test("detectSnakeProp finds snake props on raw object", () => {
    assert.deepStrictEqual(detectSnakeProp({ snakeCount: 3 }), { propName: "snakeCount", value: 3 });
    // every listed prop name is detectable when present with a positive number
    for (const name of SNAKE_PROP_NAMES) {
        assert.deepStrictEqual(detectSnakeProp({ [name]: 2 }), { propName: name, value: 2 });
    }
    assert.strictEqual(detectSnakeProp({ snakeCount: 0 }), null); // non-positive ignored
    assert.strictEqual(detectSnakeProp({ snakeCount: "x" }), null); // non-number ignored
    assert.strictEqual(detectSnakeProp({ nope: 1 }), null);
    assert.strictEqual(detectSnakeProp(null), null);
});

test("classify routes by shape", () => {
    const variantMap = {};
    for (let i = 0; i < 15; i++) variantMap[i] = "v" + i;
    assert.strictEqual(classify(variantMap).kind, "variant");
    const petals = [];
    for (let i = 0; i < 50; i++) petals.push({ id: i, name: "Petal", desc: "d" });
    assert.strictEqual(classify(petals).kind, "petal");
    assert.strictEqual(classify("nope"), null);
});

test("snake slug patterns match legacy slugs", () => {
    assert.strictEqual(isSnakeSlug("centipede"), true);
    assert.strictEqual(isSnakeSlug("rattlesnake"), true);
    assert.strictEqual(isSnakeSlug("hel_beetle"), false);
    for (const re of SNAKE_SLUG_PATTERNS) assert.ok(re instanceof RegExp);
});

test("extractSnakeIndicesFromRaw uses snakeCount on raw mobs", () => {
    const raw = [{ id: 1, snakeCount: 4 }, { id: 2 }, { id: 3, snakeCount: 0 }, { id: 4, snakeCount: 2 }];
    assert.deepStrictEqual(extractSnakeIndicesFromRaw(raw), [0, 3]);
    assert.deepStrictEqual(extractSnakeIndicesFromRaw([]), []);
});
