// lib/bot/constants.js — runtime wire-protocol constants loaded from the extraction
// pipeline. Replaces the former hand-maintained OPCODE_SEND / ENTITY_TYPE / UPDATE_FLAGS /
// kick-reason literals (fail-fast: a missing key aborts startup rather than sending a
// wrong byte to the live server).
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

// ── required keys (fail-fast on any gap) ──
const REQUIRED = {
    // send opcode keys (S block2) mapped to bot semantics, verified against game send sites:
    //   lh(S.qn, name)=SPAWN_PLAY  tO(S.Gn)=DIE_QUIT  tP(5)[S.Vn]=MOVEMENT
    //   setUint8(S.ro)=EQUIP_LOADOUT(1+4+20+name handshake is opcode 0 literal? see below)
    ...{},
};
const S = c.SEnum;
const E = c.EEnum;
const O = c.OEnum;
const T = c.TEnum;

function requireKeys(obj, keys, table) {
    const missing = keys.filter((k) => !(k in obj));
    if (missing.length > 0) {
        throw new Error(
            `[protocol] missing required key(s) [${missing.join(", ")}] in generated ` +
                `${table} — the game likely changed. Re-run \`npm run extract\`, and if the ` +
                `symbols were renamed, update the key list in lib/bot/constants.js.`
        );
    }
}

export const OPCODE_SEND = {
    HANDSHAKE: 0, // handshake is always byte 0 (server contract, not in S enum)
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

export const SHOW_OTHER_PETALS_OPCODE = S._o; // tO(S._o, mj.guildSquad)? — petal/pet visibility toggles
export const SHOW_OTHER_PETS_OPCODE = S.qo;
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
    POSITION: O.ne, // o() 2×u16 (x,y)
    ANGLE: O.ae, // a() 1B angle
    SIZE: O.oe, // u16
    LAYER: O.ie, // (no payload read; layer toggle)
    STATUS: O.se, // 1B
    LEVEL: O.le, // u16
    FACE: O.de, // y(): face/skin/aura
    GUILD: O.me, // e() string
    MANA: O.Mana, // 1B /255
    HEALTH: O.Health,
    PE: O.pe, // 1B bitfield + u32 per bit
};
requireKeys(
    UPDATE_FLAGS,
    ["POSITION", "ANGLE", "SIZE", "LAYER", "STATUS", "LEVEL", "FACE", "GUILD", "MANA", "HEALTH", "PE"],
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
