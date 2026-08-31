// npm run extract:constants — full extraction chain with cache freshness:
//  1. fetch the live game JS URL (~300ms HTML check)
//  2. ensure the deobfuscated output matches that URL (re-runs zorr-deobfuscator on game update)
//  3. derive protocol_constants.json tied to that URL (lib/bot/constants.js loads it fail-fast)
//  4. run the existing VM extraction to refresh game data + protocol version
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const deobfDir = path.join(root, "zorr-deobfuscator", "deobfuscated");

// ── 1. live game source URL ──
console.log("[extract] checking live game source URL...");
const { fetchJsUrlFromHtml } = await import(
    new URL("../source_fetcher.js", `file://${__dirname.replace(/\\/g, "/")}/`).href
);
const { jsUrl } = await fetchJsUrlFromHtml();
const base = path.basename(jsUrl.split("?")[0]).replace(/\.js$/, "");
console.log(`[extract] live game source: ${jsUrl}`);

// ── 2. deobfuscated source (regenerate when the game URL changed) ──
import fs from "node:fs";
const deobfFiles = fs.existsSync(deobfDir) ? fs.readdirSync(deobfDir) : [];
const matching = `${base}-deobfuscated.js`;
if (!deobfFiles.includes(matching)) {
    console.log(
        `[extract] deobfuscated output for ${base} missing (game updated?) — ` +
            `running zorr-deobfuscator (fetch + webcrack + deobf)...`
    );
    const r = spawnSync("node", ["main.js"], { cwd: path.join(root, "zorr-deobfuscator"), stdio: "inherit" });
    if (r.status !== 0) {
        console.error("[extract] deobfuscator failed");
        process.exit(1);
    }
    if (!fs.readdirSync(deobfDir).includes(`${base}-deobfuscated.js`)) {
        console.error(`[extract] deobfuscator ran but ${base}-deobfuscated.js still missing`);
        process.exit(1);
    }
} else {
    console.log(`[extract] deobfuscated source for ${base} is up to date`);
}

// ── 3. protocol constants (tied to the live URL) ──
console.log("[extract] deriving protocol constants...");
{
    const r = spawnSync("node", ["scripts/extract-constants.mjs", "--js-url", jsUrl], {
        cwd: root,
        stdio: "inherit",
    });
    if (r.status !== 0) process.exit(1);
}

// ── 4. sanity: constants load + freshness against the live URL ──
console.log("[extract] validating constants load + freshness...");
const constantsUrl = new URL("../lib/bot/constants.js", `file://${__dirname.replace(/\\/g, "/")}/`).href;
const { OPCODE_SEND, ENTITY_TYPE, UPDATE_FLAGS, assertFreshFor } = await import(constantsUrl);
if (OPCODE_SEND.MOVEMENT === undefined || ENTITY_TYPE.MOB === undefined || UPDATE_FLAGS.POSITION === undefined) {
    console.error("[extract] constants validation failed");
    process.exit(1);
}
assertFreshFor(jsUrl);
console.log(`[extract] OK — MOVEMENT=${OPCODE_SEND.MOVEMENT} MOB=${ENTITY_TYPE.MOB} POSITION=${UPDATE_FLAGS.POSITION}`);

// ── 5. game-data VM extraction (petals/mobs/protocol version …) ──
console.log("[extract] running game-data VM extraction...");
const r2 = spawnSync("node", ["extract_data.js"], { cwd: root, stdio: "inherit" });
process.exit(r2.status ?? 0);
