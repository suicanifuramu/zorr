// npm run extract — full extraction chain:
//  1. ensure the deobfuscated game source exists (runs zorr-deobfuscator if stale/missing)
//  2. derive protocol_constants.json (lib/bot/constants.js loads it with fail-fast)
//  3. run the existing VM extraction to refresh game data + protocol version
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

// ── 1. deobfuscated source ──
const deobfDir = path.join(root, "zorr-deobfuscator", "deobfuscated");
const haveDeobf = fs.existsSync(deobfDir) && fs.readdirSync(deobfDir).some((f) => f.endsWith("-deobfuscated.js"));

if (!haveDeobf) {
    console.log("[extract] deobfuscated source missing — running zorr-deobfuscator (fetch + webcrack + deobf)...");
    const r = spawnSync("node", ["main.js"], { cwd: path.join(root, "zorr-deobfuscator"), stdio: "inherit" });
    if (r.status !== 0) {
        console.error("[extract] deobfuscator failed");
        process.exit(1);
    }
} else {
    console.log("[extract] deobfuscated source present");
}

// ── 2. protocol constants ──
console.log("[extract] deriving protocol constants...");
{
    const r = spawnSync("node", ["scripts/extract-constants.mjs"], { cwd: root, stdio: "inherit" });
    if (r.status !== 0) process.exit(1);
}

// ── 3. sanity: constants load fail-fast ──
console.log("[extract] validating constants load...");
const { OPCODE_SEND, ENTITY_TYPE, UPDATE_FLAGS } = await import(
    new URL("./lib/bot/constants.js", `file://${root.replace(/\\/g, "/")}/`).href
);
if (OPCODE_SEND.MOVEMENT === undefined || ENTITY_TYPE.MOB === undefined || UPDATE_FLAGS.POSITION === undefined) {
    console.error("[extract] constants validation failed");
    process.exit(1);
}
console.log(`[extract] OK — MOVEMENT=${OPCODE_SEND.MOVEMENT} MOB=${ENTITY_TYPE.MOB} POSITION=${UPDATE_FLAGS.POSITION}`);

// ── 4. game-data VM extraction (petals/mobs/protocol version …) ──
console.log("[extract] running game-data VM extraction...");
const r2 = spawnSync("node", ["extract_data.js"], { cwd: root, stdio: "inherit" });
process.exit(r2.status ?? 0);
