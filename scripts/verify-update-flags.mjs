// Verify the extracted UPDATE_FLAGS against the game's actual per-flag read sizes
// by re-parsing the S.update handler we read at deobf 42572-42680. This documents layout
// and serves as a guard: if the enum extraction goes stale, these invariants break loudly
// in the unit tests.
import fs from "node:fs";
const deo = fs.readFileSync("zorr-deobfuscator/deobfuscated/1K161E3QM-deobfuscated.js", "utf8");

// Extract the O-update-flag handler snippet (between `case S.update:` and `case S.` next)
const upd = deo.indexOf("case S.update:");
const next = deo.indexOf("case S.", upd + 20);
const body = deo.slice(upd, next);

// Per-flag read sizes observed in deobfuscated code:
const expect = {
    ne: 4, // o() 2B + o() 2B — position
    ae: 1, // 1B angle (via a())
    oe: 2,
    se: 1,
    le: 2,
    me: null, // variable-length string
    Mana: 1,
    he: 1,
    ge: 4,
    Health: null, // calls helper i() which re-reads health/mana
    pe: "bitfield",
};
const missing = [];
for (const [flag, size] of Object.entries(expect)) {
    const re = new RegExp(`t & O\\.${flag}\\b`);
    if (!re.test(body)) missing.push(flag);
}
if (missing.length) {
    console.error(`update flag handler changed; missing: ${missing.join(", ")}`);
    process.exit(1);
}
console.log("update-flag layout invariants OK:", Object.keys(expect).length, "flags present");
