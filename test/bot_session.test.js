"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const {
    LCG,
    MinHeap,
    decompressCoord,
    decodeItemValue,
    decodeStatusFlags,
    getPrintableAscii,
    decodeBuildCode,
    buildDistanceMap,
} = require("../bot_session");

test("LCG produces deterministic byte sequence", () => {
    const a = new LCG(42),
        b = new LCG(42);
    const seq = [];
    for (let i = 0; i < 10; i++) {
        const v = a.next();
        seq.push(v);
        assert.strictEqual(v, b.next());
    }
    for (const v of seq) assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, `byte out of range: ${v}`);
    // reference implementation of the same recurrence
    let s = 42 >>> 0;
    for (const expected of seq) {
        s = (s * 1664525 + 1013904223) % 4294967296;
        assert.strictEqual(expected, Math.floor((s / 4294967296) * 255));
    }
});

test("LCG coerces seed with >>> 0", () => {
    assert.strictEqual(new LCG(-1).next(), new LCG(4294967295).next());
});

test("MinHeap pops in ascending .f order", () => {
    const h = new MinHeap();
    for (const f of [5, 3, 8, 1, 9, 2, 7]) h.push({ f, id: f });
    assert.strictEqual(h.size, 7);
    const out = [];
    while (h.size > 0) out.push(h.pop().f);
    assert.deepStrictEqual(out, [1, 2, 3, 5, 7, 8, 9]);
});

test("MinHeap pop on empty returns undefined", () => {
    const h = new MinHeap();
    h.push({ f: 1 });
    h.pop();
    assert.strictEqual(h.size, 0);
    assert.strictEqual(h.pop(), undefined);
});

test("decompressCoord", () => {
    assert.strictEqual(decompressCoord(3000), 0);
    assert.strictEqual(decompressCoord(3001), 2);
    assert.strictEqual(decompressCoord(2999), -2);
});

test("decodeItemValue splits floor/32 and %32", () => {
    assert.deepStrictEqual(decodeItemValue(100), [3, 4]);
    assert.deepStrictEqual(decodeItemValue(0), [0, 0]);
    assert.deepStrictEqual(decodeItemValue(31), [0, 31]);
    assert.deepStrictEqual(decodeItemValue("97"), [3, 1]);
});

test("decodeStatusFlags maps known bits", () => {
    assert.deepStrictEqual(decodeStatusFlags(0), []);
    assert.deepStrictEqual(decodeStatusFlags(2048), ["Pinky"]); // matches AccountManager log
    assert.deepStrictEqual(decodeStatusFlags(1 | 64), ["Wg", "Rg"]);
    assert.deepStrictEqual(decodeStatusFlags(8192), ["Invisible"]);
});

test("getPrintableAscii joins runs of >=3 printable chars", () => {
    assert.strictEqual(getPrintableAscii([104, 101, 108, 108, 111]), "hello");
    assert.strictEqual(getPrintableAscii([1, 104, 105, 0, 106, 107, 108]), "jkl"); // runs < 3 ('hi') dropped
    assert.strictEqual(getPrintableAscii([1, 2]), "");
});

test("decodeBuildCode round-trips a payload", () => {
    // inverse of decodeBuildCode (decode = XOR then adjacent swap; encode = swap then XOR)
    const payload = JSON.stringify({ petals: [1, 2, 3], name: "x" });
    const data = Buffer.from(payload, "utf8");
    let lcgState = 7 >>> 0;
    const next = () => {
        lcgState = (Math.imul(lcgState, 1664525) + 1013904223) >>> 0;
        return Math.floor((lcgState / 4294967296) * 255);
    };
    for (let i = 0; i < data.length - 1; i += 2) {
        const t = data[i];
        data[i] = data[i + 1];
        data[i + 1] = t;
    }
    for (let i = 0; i < data.length; i++) data[i] ^= next() ^ next();
    const code = Buffer.concat([Buffer.alloc(8), data]);
    code.writeUInt32BE(1, 0); // BUILD_MAGIC
    code.writeUInt32BE(7, 4); // seed
    assert.deepStrictEqual(decodeBuildCode(code.toString("base64")), { petals: [1, 2, 3], name: "x" });
});

test("decodeBuildCode rejects bad input", () => {
    assert.strictEqual(decodeBuildCode(Buffer.alloc(4).toString("base64")), null); // too short
    const bad = Buffer.alloc(12);
    bad.writeUInt32BE(999, 0);
    assert.strictEqual(decodeBuildCode(bad.toString("base64")), null); // wrong magic
});

test("buildDistanceMap BFS from walls", () => {
    // grid: 0 = free (distance seeded), 1 = wall (gets distance via BFS)
    const grid = [
        [1, 0, 1],
        [0, 0, 0],
        [1, 0, 1],
    ];
    const dist = buildDistanceMap(grid, 3, 3);
    assert.deepStrictEqual(dist, [
        [1, 0, 1],
        [0, 0, 0],
        [1, 0, 1],
    ]);
});

test("buildDistanceMap accumulates distance from walls", () => {
    const grid = [
        [1, 1, 0],
        [1, 0, 0],
        [0, 0, 0],
    ];
    const dist = buildDistanceMap(grid, 3, 3);
    assert.strictEqual(dist[0][0], 2); // wall 2 steps from free zone
    assert.strictEqual(dist[1][0], 1);
    assert.strictEqual(dist[2][0], 0);
});
