// extract_protocol_constants.mjs — derive wire-protocol constants from the game source.
//
// Strategy: the game's opcode/flag enums are N()/R()-numbered maps (`var S = {...N({...})}`)
// whose *numeric values* depend only on key enumeration order. The deobfuscator output
// (zorr-deobfuscator/deobfuscated/*.js) contains these maps fully un-mangled, so we:
//   1. Locate `function N(`, `function R(`, and each `var X = N({...})` / `X = R({...})`
//      declaration in the deobfuscated source.
//   2. Sandbox-evaluate just that snippet (stubbing the string decoder D7 — N/R numeric
//      assignment does not depend on key strings).
//   3. Emit protocol_constants.json with every S/T/O/P/Q entry keyed by NAME.
//
// Usage: node scripts/extract-constants.mjs [--deobf <path>]
//   Without --deobf, runs zorr-deobfuscator/main.js first when the output is stale.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const deobfDir = path.join(root, "zorr-deobfuscator", "deobfuscated");

// --js-url <url>: pick the deobfuscated output matching the CURRENT live game source
// (its file name embeds the JS base name, e.g. 1K161E3QM). When given and no matching
// output exists, we fail — the game updated and the deobfuscator must re-run first
// (extract-all.mjs handles that automatically).
let expectBase = null;
const jsUrlArgIdx = process.argv.indexOf("--js-url");
if (jsUrlArgIdx !== -1 && process.argv[jsUrlArgIdx + 1]) {
    expectBase = path.basename(process.argv[jsUrlArgIdx + 1].split("?")[0]).replace(/\.js$/, "");
}

const deobfFiles = fs.readdirSync(deobfDir).filter((f) => f.endsWith("-deobfuscated.js"));
if (deobfFiles.length === 0) {
    console.error("[constants] deobfuscated source not found. Run: node zorr-deobfuscator/main.js");
    process.exit(1);
}
let deobfFile;
if (expectBase) {
    const wanted = `${expectBase}-deobfuscated.js`;
    if (!deobfFiles.includes(wanted)) {
        console.error(
            `[constants] game source updated: current URL base "${expectBase}" has no ` +
                `deobfuscated output (have: ${deobfFiles.join(", ")}). ` +
                `Re-run \`npm run extract:constants\` which regenerates it via the deobfuscator.`
        );
        process.exit(1);
    }
    deobfFile = { f: wanted };
} else {
    deobfFile = deobfFiles
        .map((f) => ({ f, m: fs.statSync(path.join(deobfDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m)[0];
}
const srcPath = path.join(deobfDir, deobfFile.f);
const src = fs.readFileSync(srcPath, "utf8");
console.log(`[constants] parsing ${path.basename(srcPath)} (${(src.length / 1e6).toFixed(1)}MB)`);

// ── locate enum declarations ──
function findDecl(name, kind) {
    // `var S = {` / `T = N({` / `O = R({` …
    const re = new RegExp(`(?:var\\s+|const\\s+|let\\s+)?\\b${name}\\s*=\\s*${kind}\\(\\{`);
    const m = re.exec(src);
    return m ? m.index : -1;
}
function balancedEnd(startIdx) {
    // startIdx points at '{'
    let depth = 0,
        instr = null,
        esc = false;
    for (let i = startIdx; i < src.length; i++) {
        const c = src[i];
        if (esc) {
            esc = false;
            continue;
        }
        if (c === "\\") {
            esc = true;
            continue;
        }
        if (instr) {
            if (c === instr) instr = null;
            continue;
        }
        if (c === '"' || c === "'" || c === "`") {
            instr = c;
            continue;
        }
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

const nAt = src.indexOf("function N(");
const rAt = src.indexOf("function R(");
if (nAt === -1 || rAt === -1) {
    console.error("[constants] N()/R() not found — deobfuscator output outdated?");
    process.exit(1);
}
// Enums live BEFORE the N/R function definitions in the deobf source (function decls are
// hoisted), so scan from the earliest `var B = N({` rather than from the N() definition.
const firstEnumDecl = src.search(/\b(?:var|const|let)\s+[A-Za-z0-9_$]+\s*=\s*N\s*\(/);
const declStart = firstEnumDecl === -1 ? Math.min(nAt, rAt) : firstEnumDecl;

// Collect every `var X = N({...})` / `X = R({...})`, plus spread form `S = { ...N({...}), ...N({...}) }`
const enumVars = {};
const reEnum = /\b(?:var|const|let)?\s*([A-Za-z0-9_$]+)\s*=\s*(N|R)\(\{/g;
reEnum.lastIndex = declStart;
let guard = 0;
let m;
while ((m = reEnum.exec(src)) && guard++ < 64) {
    const [, name, fn] = m;
    const openBrace = src.indexOf("{", m.index + m[0].length - 1);
    if (openBrace === -1) continue;
    const close = balancedEnd(openBrace);
    if (close === -1) continue;
    enumVars[name] = { kind: m[2], start: openBrace, end: close };
}

// Spread form: `var S = { ...N({...}), ...N({...}) }` — sequential numbering across ALL
// nested N() blocks (the spread merges maps sharing one counter sequence? No: each N()
// call restarts at 0. Verify against bot hardcode: HANDSHAKE..CLAIM_STREAK are 0..128
// contiguous in the SECOND N block; the first block is recv-side opcodes).
const sSpread = src.indexOf("var S = {", declStart);
if (sSpread !== -1) {
    const sOpen = src.indexOf("{", sSpread);
    const sClose = balancedEnd(sOpen);
    // find N({...}) blocks within
    const inner = src.slice(sOpen, sClose);
    const reBlocks = [...inner.matchAll(/\.\.\.N\(\{/g)];
    const blocks = [];
    for (const b of reBlocks) {
        const ob = sOpen + b.index + b[0].length - 1;
        const cb = balancedEnd(ob);
        if (cb !== -1) blocks.push([ob, cb]);
    }
    enumVars.S = { kind: "SPREAD_N", blocks, start: sOpen, end: sClose };
}

// Build a snippet: N + R + all enum decls, executed in a sandbox.
const names = Object.keys(enumVars).filter((n) => n !== "N" && n !== "R");
const parts = [`function N(t) { let e = 0; for (const n in t) { t[n] = e; e++; } t.length = e; return t; }`];
parts.push(
    `function R(t) { let n = 0; for (const e in t) { t[e] = 1 << n; n++; } t.Te = Math.pow(2, n) - 1; return t; }`
);
for (const name of names) {
    const ev = enumVars[name];
    if (ev.kind === "SPREAD_N") {
        // Each N(...N-block...) restarts its own counter; the spread merges them by name.
        parts.push(`${name} = {};`);
        let bi = 0;
        for (const [ob, cb] of ev.blocks) {
            parts.push(
                `var __blk${bi} = N(${src.slice(ob, cb + 1)}); delete __blk${bi}.length; Object.assign(${name}, __blk${bi});`
            );
            bi++;
        }
    } else {
        parts.push(`${name} = ${ev.kind}(${src.slice(ev.start, ev.end + 1)});`);
        parts.push(`delete ${name}.length;`);
        parts.push(`delete ${name}.Te;`);
    }
}
parts.push(`globalThis.__enums = { ${names.join(", ")} };`);

// N() in deobf body still reads t[n(2283)]="length" via D7 — but that's only the .length
// side-effect; numeric values assigned to keys are independent. Emulate exactly:
parts.unshift(`const D7 = () => "length";`);

const sandbox = { globalThis: {} };
sandbox.globalThis = sandbox;
vm.runInNewContext(`(function(){ ${parts.join("\n")} })();`, sandbox, { timeout: 10000 });
const enums = sandbox.__enums;

// ── status-flag bitmask (sv() function, deobf ~line 40745) ──
// Each `t.X = !!(a & N)` line maps a semantic name to a bit. Extract programmatically so
// PINKY_BITMASK / Third Eye etc track game updates instead of hardcoding 2048.
function extractStatusFlags() {
    const at = src.indexOf("function sv(t, n, e)");
    if (at === -1) throw new Error("sv() status-flag function not found");
    const end = balancedEnd(src.indexOf("{", at));
    const body = src.slice(at, end);
    const flags = {};
    for (const m of body.matchAll(/t\.([A-Za-z0-9_$]+)\s*=\s*!!\(a & (\d+)\)/g)) {
        flags[Number(m[2])] = m[1];
    }
    return flags;
}
const statusFlags = extractStatusFlags();
const PINKY_BITMASK_EXTRACTED = Number(Object.keys(statusFlags).find((k) => statusFlags[k] === "_s")) || 2048;

// ── build the full constants payload ──
const out = {
    _meta: {
        source: path.basename(srcPath),
        // jsUrl tied to the deobfuscated output's base name, so consumers can
        // detect that the constants belong to the currently live game source.
        jsUrl: expectBase ? process.argv[jsUrlArgIdx + 1] : null,
        extractedAt: new Date().toISOString(),
    },
    // S split into recv/send opcode tables by their N-block of origin:
    //   block1 (recv, server→client): Ie=0 KICK, Fe=1 LOBBY, update=3 ENTITY_UPDATE, ...
    //   block2 (send, client→server): Un=0..fi — wired straight to tO()/tP() send sites.
    flags: enums.O, // UPDATE_FLAGS (O.R-map): ne=POSITION ae=ANGLE oe=SIZE ... Health=8192 pe=16384
    kickReasons: enums.T, // kick reason byte → name (invalidProtocol, outdatedVersion, ...)
    entityTypes: enums.E, // entity type ids (Entity=0, N=PLAYER=1, H=PETAL=2, R=MOB=3, ...)
    rarities: enums.I, // rarity ids (Normal=0, Magic=1, ...)
    itemEncoding: { BUILD_AX: 32 }, // az(id, rarity) = id * ay + rarity (ay=32, deobf line ~1689)
    statusFlags, // sv(): bit → client property (1024=showThirdEye, 2048=_s[=Pinky], ...)
    pinkyBitmask: PINKY_BITMASK_EXTRACTED, // t._s assignment inside sv()
};
for (const name of names) {
    const e = enums[name] || {};
    const clean = {};
    for (const [k, v] of Object.entries(e)) {
        if (typeof v === "number" && k !== "length" && k !== "Te") clean[k] = v;
    }
    out[`${name}Enum`] = clean;
}

console.log("[constants] enums found:", names.join(", "));
for (const name of names) {
    const e = out[`${name}Enum`];
    console.log(`  ${name}: ${Object.keys(e).length} keys`);
}
fs.mkdirSync(path.join(root, "generated"), { recursive: true });
fs.writeFileSync(path.join(root, "generated", "protocol_constants.json"), JSON.stringify(out, null, 2));
console.log("[constants] wrote generated/protocol_constants.json");
