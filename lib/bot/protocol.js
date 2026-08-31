// protocol.js — pure packet helpers, LCG, MinHeap and grid pathfinding primitives shared
// by the bot session and tests. All wire constants (opcodes, flags, entity types, kick
// reasons) come from the extraction pipeline via lib/bot/constants.js (fail-fast).
import _talentData from "../../talent_data.js";
import {
    OPCODE_SEND,
    SHOW_OTHER_PETS_OPCODE,
    SHOW_OTHER_PETALS_OPCODE,
    BUILD_MAGIC,
    BUILD_AX,
    ENTITY_TYPE,
    UPDATE_FLAGS,
    KICK_REASONS,
    PINKY_BITMASK,
} from "./constants.js";

export const talentSlugToId = {};
for (const t of _talentData) talentSlugToId[t.slug] = t.id;

const CENTER_COST = 25;
const _FRANTIC_DIRS = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
];
const _FRANTIC_MAX_MS = 8000;
const AP_LOG_MAX = 50;
const _CONTROL_BACKOFF_INITIAL_MS = 2000;
const _CONTROL_BACKOFF_MAX_MS = 30000;

class LCG {
    constructor(seed) {
        this.seed = seed >>> 0;
    }
    next() {
        this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
        return Math.floor((this.seed / 4294967296) * 255);
    }
}

class MinHeap {
    constructor() {
        this.data = [];
    }
    get size() {
        return this.data.length;
    }
    push(item) {
        this.data.push(item);
        let i = this.data.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.data[p].f <= this.data[i].f) break;
            [this.data[p], this.data[i]] = [this.data[i], this.data[p]];
            i = p;
        }
    }
    pop() {
        const top = this.data[0];
        const last = this.data.pop();
        if (this.data.length > 0) {
            this.data[0] = last;
            let i = 0;
            while (true) {
                let smallest = i;
                const l = 2 * i + 1,
                    r = 2 * i + 2;
                if (l < this.data.length && this.data[l].f < this.data[smallest].f) smallest = l;
                if (r < this.data.length && this.data[r].f < this.data[smallest].f) smallest = r;
                if (smallest === i) break;
                [this.data[smallest], this.data[i]] = [this.data[i], this.data[smallest]];
                i = smallest;
            }
        }
        return top;
    }
}

// Pure utility functions (no state)
function decodeItemValue(val) {
    val = parseInt(val);
    return [Math.floor(val / 32), val % 32];
}
function decompressCoord(raw) {
    return (raw - 3000) * 2;
}
function readString(view, offset) {
    const len = view.getUint8(offset);
    offset += 1;
    if (offset + len > view.byteLength) return { value: "", newOffset: offset };
    let str = "";
    for (let i = 0; i < len; i++) str += String.fromCharCode(view.getUint8(offset + i));
    return { value: str, newOffset: offset + len };
}
function decodeStatusFlags(flags) {
    const s = [];
    if (flags & 1) s.push("Wg");
    if (flags & 2) s.push("Lifesteal");
    if (flags & 4) s.push("cp");
    if (flags & 8) s.push("Gg");
    if (flags & 64) s.push("Rg");
    if (flags & 128) s.push("tg");
    if (flags & 256) s.push("dg");
    if (flags & 512) s.push("qg");
    if (flags & 1024) s.push("Third Eye");
    if (flags & 2048) s.push("Pinky");
    if (flags & 4096) s.push("dp");
    if (flags & 8192) s.push("Invisible");
    if (flags & 16384) s.push("Yg");
    if (flags & 32768) s.push("mg");
    if (flags & 65536) s.push("Bandages");
    if (flags & 131072) s.push("Kg");
    if (flags & 262144) s.push("Xg");
    return s;
}
function getPrintableAscii(bytes) {
    let result = [],
        currentStr = "";
    for (const b of bytes) {
        if (b >= 32 && b <= 126) currentStr += String.fromCharCode(b);
        else {
            if (currentStr.length >= 3) result.push(currentStr);
            currentStr = "";
        }
    }
    if (currentStr.length >= 3) result.push(currentStr);
    return result.join(" | ");
}
function buildDistanceMap(grid, rows, cols) {
    const dist = Array.from({ length: rows }, () => Array(cols).fill(Infinity));
    const queue = [];
    for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++)
            if (grid[y][x] === 0) {
                dist[y][x] = 0;
                queue.push([x, y]);
            }
    let head = 0;
    const dirs = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
    ];
    while (head < queue.length) {
        const [x, y] = queue[head++];
        for (const [dx, dy] of dirs) {
            const nx = x + dx,
                ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            if (dist[ny][nx] > dist[y][x] + 1) {
                dist[ny][nx] = dist[y][x] + 1;
                queue.push([nx, ny]);
            }
        }
    }
    return dist;
}
function decodeBuildCode(b64) {
    const raw = Buffer.from(b64, "base64");
    if (raw.length < 8) return null;
    const magic = raw.readUInt32BE(0);
    if (magic !== BUILD_MAGIC) return null;
    const seed = raw.readUInt32BE(4);
    const data = raw.subarray(8);
    let lcgState = seed >>> 0;
    function lcgNext() {
        lcgState = (Math.imul(lcgState, 1664525) + 1013904223) >>> 0;
        return Math.floor((lcgState / 4294967296) * 255);
    }
    for (let i = 0; i < data.length; i++) data[i] ^= lcgNext() ^ lcgNext();
    for (let i = 0; i < data.length - 1; i += 2) {
        const tmp = data[i];
        data[i] = data[i + 1];
        data[i + 1] = tmp;
    }
    return JSON.parse(new TextDecoder().decode(data));
}

export {
    OPCODE_SEND,
    SHOW_OTHER_PETS_OPCODE,
    SHOW_OTHER_PETALS_OPCODE,
    BUILD_MAGIC,
    BUILD_AX,
    ENTITY_TYPE,
    UPDATE_FLAGS,
    CENTER_COST,
    _FRANTIC_DIRS,
    _FRANTIC_MAX_MS,
    AP_LOG_MAX,
    _CONTROL_BACKOFF_INITIAL_MS,
    _CONTROL_BACKOFF_MAX_MS,
    LCG,
    MinHeap,
    decodeItemValue,
    decompressCoord,
    readString,
    decodeStatusFlags,
    getPrintableAscii,
    buildDistanceMap,
    decodeBuildCode,
};
