// lib/bot/constants.js — runtime wire-protocol constants loaded from the extraction
// pipeline. Replaces the former hand-maintained OPCODE_SEND / ENTITY_TYPE / UPDATE_FLAGS /
// kick-reason literals (fail-fast: a missing key aborts startup rather than sending a
// wrong byte to the live server).
// PING = S._n (tM = Date.now() right before tO(S._n); PONG = S.Pn at 1s interval) and
// HANDSHAKE = 0 are server-contract literals verified on the live server.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONSTANTS_PATH = path.join(__dirname, "..", "..", "generated", "protocol_constants.json");

function load() {
    if (!fs.existsSync(CONSTANTS_PATH)) {
        throw new Error(
            `[protocol] ${CONSTANTS_PATH} not found. Run \`npm run extract\` (which regenerates the ` +
                `deobfuscated game source and this file) before starting the bot — refusing to ` +
                `use stale hand-coded opcodes.`
        );
    }
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(CONSTANTS_PATH, "utf8"));
    } catch (e) {
        throw new Error(`[protocol] failed to parse protocol_constants.json: ${e.message}`);
    }
    const fresh = Date.now() - new Date(parsed._meta.extractedAt).getTime();
    const day = 24 * 60 * 60 * 1000;
    if (fresh > 3 * day) {
        console.warn(
            `[protocol] protocol_constants.json is ${Math.floor(fresh / day)} days old — ` +
                `re-run \`npm run extract\` if the game updated recently.`
        );
    }
    return parsed;
}

const c = load();

/**
 * Fail-fast freshness check: the constants must have been derived from the
 * game source that is currently live. Call with the jsUrl obtained from the
 * game-data extraction (gameData.sourceUrl). A mismatch means the game updated
 * after the last `npm run extract:constants` — the opcodes may have shifted.
 * @param {string} jsUrl  current game source URL (e.g. from gameData.sourceUrl)
 */
export function assertFreshFor(jsUrl) {
    const cached = c._meta.jsUrl;
    if (!cached) {
        throw new Error(
            "[protocol] protocol_constants.json has no recorded game URL (regenerate with `npm run extract:constants`) — refusing to start with unverified opcodes."
        );
    }
    if (cached !== jsUrl) {
        throw new Error(
            `[protocol] game source updated since constants were extracted:\n` +
                `  constants: ${cached}\n  live:      ${jsUrl}\n` +
                `Re-run \`npm run extract:constants\` to regenerate, then restart.`
        );
    }
}

const S = c.SEnum;
const E = c.EEnum;
const O = c.OEnum;
const T = c.TEnum;

/** Assert the S table has every key the bot references; abort on a renamed/missing symbol. */
function requireSendKeys(keys) {
    const missing = keys.filter((k) => !(k in S));
    if (missing.length > 0) {
        throw new Error(
            `[protocol] missing required S key(s) [${missing.join(", ")}] in generated ` +
                `SEnum — the game likely changed. Re-run \`npm run extract:constants\`, and if ` +
                `the symbols were renamed, update the key list in lib/bot/constants.js.`
        );
    }
}

function requireKeys(obj, keys, table) {
    const missing = keys.filter((k) => !(k in obj));
    if (missing.length > 0) {
        throw new Error(
            `[protocol] missing required key(s) [${missing.join(", ")}] in generated ` +
                `${table} — the game likely changed. Re-run \`npm run extract:constants\`, and if ` +
                `the symbols were renamed, update the key list in lib/bot/constants.js.`
        );
    }
}

export const OPCODE_SEND = {
    HANDSHAKE: 0, // handshake is always byte 0 (server contract, not in S enum)
    PING: S._n, // 1s heartbeat: tM = Date.now() right before tO(S._n, flag); PONG = S.Pn
    SPAWN_PLAY: S.qn, // lh(S.qn, name) — play button
    DIE_QUIT: S.Gn, // tO(S.Gn) — quit button
    MOVEMENT: S.Vn, // tP(5)[S.Vn] — x/y/flags/127
    EQUIP_LOADOUT: S.ro, // setUint8(S.ro) — topRow/bottomRow equip
    TALENT_RESET: S.Wo, // setUint8(S.Wo)+setUint16 — talent reset
    TALENT_APPLY: S.li,
    CLAIM_STREAK: S.na, // daily streak claim dialog
};
requireKeys(
    OPCODE_SEND,
    [
        "HANDSHAKE",
        "PING",
        "SPAWN_PLAY",
        "DIE_QUIT",
        "MOVEMENT",
        "EQUIP_LOADOUT",
        "TALENT_RESET",
        "TALENT_APPLY",
        "CLAIM_STREAK",
    ],
    "sendOpcodes"
);
export const SHOW_OTHER_PETALS_OPCODE = S._o; // tO(S._o, ...) — petal visibility toggle
export const SHOW_OTHER_PETS_OPCODE = S.qo; // tO(S.qo, ...) — pet/pet visibility toggle
requireKeys(
    { petals: SHOW_OTHER_PETALS_OPCODE, pets: SHOW_OTHER_PETS_OPCODE },
    ["petals", "pets"],
    "showOther opcodes"
);

export const BUILD_MAGIC = 1; // internal build-code format version (this repo's own encoding)
export const BUILD_AX = c.itemEncoding.BUILD_AX; // az(id, rarity) = id * ax + rarity

export const ENTITY_TYPE = {
    ENTITY: E.Entity,
    PLAYER: E.N,
    PETAL: E.H,
    MOB: E.R,
    DROP: E.F,
    ZONE_O: E.L,
    ZONE_B: E.O,
    ZONE_U: E.B,
    UNDERSCORE: E.U,
    ZONE_G: E._,
    ZONE_Q: E.q,
    WALL: E.G,
    ZONE_V: E.j,
    LIGHTNING: E.p,
    EXPLOSION: E.v,
};
requireKeys(
    ENTITY_TYPE,
    [
        "ENTITY",
        "PLAYER",
        "PETAL",
        "MOB",
        "DROP",
        "ZONE_O",
        "ZONE_B",
        "ZONE_U",
        "UNDERSCORE",
        "ZONE_G",
        "ZONE_Q",
        "WALL",
        "ZONE_V",
        "LIGHTNING",
        "EXPLOSION",
    ],
    "entityTypes"
);

export const UPDATE_FLAGS = {
    // Read sizes verified against the game's S.update handler (deobf): each
    // flagged field must consume exactly these bytes or the whole entity
    // stream desyncs (mob-list garbage / "invalid mob index" storm).
    POSITION: O.ne, // o() 2B + o() 2B = 4B (x,y)
    ANGLE: O.ae, // 1B angle
    SIZE: O.oe, // u16
    LAYER: O.ie, // 0B payload (client-side layer toggle)
    SE: O.se, // 1B
    STATUS: O.re, // sv(): u32 status bitmask (incl. Pinky bit _s)
    LEVEL: O.le, // u16
    FACE: O.de, // y(): 3×u8 (face/skin/aura)
    CE: O.ce, // 1B
    GUILD: O.me, // var-length string
    MANA: O.Mana, // 1B /255
    HE: O.he, // 1B bool
    GE: O.ge, // f32
    HEALTH: O.Health, // i(): 2B (hp+mana)
    PE: O.pe, // 1B bitfield + u32 per set bit
};
requireKeys(
    UPDATE_FLAGS,
    [
        "POSITION",
        "ANGLE",
        "SIZE",
        "LAYER",
        "SE",
        "STATUS",
        "LEVEL",
        "FACE",
        "CE",
        "GUILD",
        "MANA",
        "HE",
        "GE",
        "HEALTH",
        "PE",
    ],
    "updateFlags"
);

// Kick reason bytes (opcode-0 payload) — T order matches the bot's old reason array.
export const KICK_REASONS = [
    T.invalidProtocol,
    T.outdatedVersion,
    T.tooManyConnections,
    T.afk,
    T.loginFailed,
    T.banned,
    T.adminAction,
    T.restricted,
];
requireKeys(
    T,
    [
        "invalidProtocol",
        "outdatedVersion",
        "tooManyConnections",
        "afk",
        "loginFailed",
        "banned",
        "adminAction",
        "restricted",
    ],
    "kickReasons"
);

// Pinky bit: extracted from the game's status-flag reader sv() (t._s = !!(a & N)).
export const PINKY_BITMASK = c.pinkyBitmask;
if (!PINKY_BITMASK) {
    throw new Error(
        "[protocol] pinkyBitmask missing from protocol_constants.json — re-run `npm run extract:constants`"
    );
}
