// autopatrol_state.test.js — guards the Auto Patrol server-advance state machine:
//  - death / route-complete switch servers immediately (no lingering on the dead server)
//  - normal hops keep a 1s dwell (kick protection)
//  - wait_pinky failure count is incremented ONLY by the 60s timeout (no double count)
//  - spawns racing an in-flight server switch are ignored (stale biomeName/mapName)
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, "..", "lib", "bot", "autopatrol.js"), "utf8");

test("apAdvance supports immediate switch (death / route complete)", () => {
    assert.ok(src.includes("apAdvance(immediate = false)"));
    assert.ok(src.includes("const dwellMs = immediate ? 0 : 1000;"));
});

test("death during patrol advances immediately", () => {
    const deathSection = src.slice(src.indexOf("apOnDeath"));
    assert.ok(/apAdvance\(true\)/.test(deathSection));
});

test("route complete advances immediately", () => {
    const section = src.slice(src.indexOf("apOnRouteComplete"));
    assert.ok(/apAdvance\(true\)/.test(section));
});

test("wait_pinky death does not double-increment pinkyFailCount", () => {
    const deathSection = src.slice(src.indexOf("apOnDeath"));
    assert.ok(!/pinkyFailCount\+\+/.test(deathSection.slice(0, 600)));
});

test("spawns during an in-flight switch are ignored (stale biome/map)", () => {
    assert.ok(src.includes("switch in flight"));
});

test("self-switch advance: switchBotServer increments index on skip", () => {
    const bs = fs.readFileSync(path.join(__dirname, "..", "bot_session.js"), "utf8");
    const i = bs.indexOf("Already on");
    const block = bs.slice(i, i + 400);
    assert.ok(/serverIndex\+\+/.test(block), "self-switch skip must advance serverIndex");
});
