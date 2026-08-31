// tests/protocol_constants.test.js — guards the extracted protocol constants:
//  1. fail-fast load works when generated/protocol_constants.json exists
//  2. wire values match the last-known-good live-server-verified numbers
//  3. layout invariants of the S.update handler (flags → read sizes) still hold
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const constantsPath = path.join(root, "generated", "protocol_constants.json");

test("generated protocol_constants.json exists (npm run extract:constants)", () => {
    assert.ok(fs.existsSync(constantsPath), "run `npm run extract:constants` first");
});

const c = JSON.parse(fs.readFileSync(constantsPath, "utf8"));

test("wire opcodes match live-server-verified values", () => {
    const S = c.SEnum;
    // These numbers were verified against the LIVE server via run_capture (handshake+spawn OK).
    // If the game updates and they shift, the bot hard-fails at startup (lib/bot/constants.js).
    assert.strictEqual(S.qn, 2); // SPAWN_PLAY
    assert.strictEqual(S.Gn, 3); // DIE_QUIT
    assert.strictEqual(S.Vn, 5); // MOVEMENT
    assert.strictEqual(S.ro, 74); // EQUIP_LOADOUT
    assert.strictEqual(S.Wo, 112); // TALENT_RESET
    assert.strictEqual(S.li, 128); // TALENT_APPLY
    assert.strictEqual(S.na, 16); // CLAIM_STREAK
    assert.strictEqual(S._o, 107); // SHOW_OTHER_PETALS
    assert.strictEqual(S.qo, 108); // SHOW_OTHER_PETS
});

test("recv opcodes: entity update = 3", () => {
    assert.strictEqual(c.SEnum.update, 3);
});

test("kick reasons match previous reason array", () => {
    assert.deepStrictEqual(Object.values(c.TEnum).slice(0, 8), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.strictEqual(Object.keys(c.TEnum)[0], "invalidProtocol");
});

test("entity types match previous ENTITY_TYPE map", () => {
    const expected = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
    assert.deepStrictEqual(Object.values(c.EEnum), expected);
});

test("item encoding BUILD_AX = 32 (id * 32 + rarity + 1)", () => {
    assert.strictEqual(c.itemEncoding.BUILD_AX, 32);
});

test("lib/bot/constants.js loads and exposes expected wire values", () => {
    delete globalThis.__constantsCache;
    return import("../lib/bot/constants.js").then((m) => {
        assert.strictEqual(m.OPCODE_SEND.MOVEMENT, 5);
        assert.strictEqual(m.ENTITY_TYPE.MOB, 3);
        assert.strictEqual(m.UPDATE_FLAGS.POSITION, 1);
        assert.strictEqual(m.BUILD_AX, 32);
    });
});

test("constants record the game source URL they were derived from", () => {
    assert.ok(c._meta.jsUrl, "run `npm run extract:constants` to record the source URL");
    assert.match(c._meta.jsUrl, /^https:\/\/zorr\.pages\.dev\/[A-Za-z0-9_-]+\.js$/);
    const base = path.basename(c._meta.jsUrl.split("?")[0]).replace(/\.js$/, "");
    assert.strictEqual(c._meta.source, `${base}-deobfuscated.js`);
});

test("assertFreshFor passes for the recorded URL and throws for a stale one", async () => {
    const m = await import("../lib/bot/constants.js");
    m.assertFreshFor(c._meta.jsUrl); // must not throw
    assert.throws(() => m.assertFreshFor("https://zorr.pages.dev/STALE000.js"), /game source updated/);
    assert.throws(() => m.assertFreshFor(undefined), /no recorded game URL|game source updated/);
});

test("extracted pinky bitmask matches the sv() _s flag and the live-verified 2048", () => {
    assert.strictEqual(c.statusFlags[2048], "_s");
    assert.strictEqual(c.pinkyBitmask, 2048);
});

test("S.update handler flag-layout invariants hold in current source", () => {
    const deobfDir = path.join(root, "zorr-deobfuscator", "deobfuscated");
    const file = fs.readdirSync(deobfDir).find((f) => f.endsWith("-deobfuscated.js"));
    assert.ok(file, "deobfuscated source missing — run npm run extract:constants");
    const r = spawnSync("node", [path.join(root, "scripts", "verify-update-flags.mjs")], {
        cwd: root,
    });
    assert.strictEqual(r.status, 0, r.stderr.toString());
});
