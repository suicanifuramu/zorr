// rendering.js — mob-map image rendering (PNG + 5x7 bitmap font + TTF fallback)
// and the Discord alert that sends it.
// ponytail: mixins are copied onto BotSession.prototype; full typing blocked on 285 this-props errors, revisit when Phase 7 completes
// @ts-nocheck
import { PNG } from "pngjs";
import opentype from "opentype.js";
import https from "node:https";
import fs from "node:fs";

// 5x7 bitmap font (7 rows per glyph, each row a 5-bit mask LSB=left) for mob-map labels. Uppercase alnum + basic punctuation.
const _FONT57 = {
    A: [0x1f, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
    B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
    C: [0x0f, 0x10, 0x10, 0x10, 0x10, 0x10, 0x0f],
    D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
    E: [0x1f, 0x10, 0x10, 0x1f, 0x10, 0x10, 0x1f],
    F: [0x1f, 0x10, 0x10, 0x1f, 0x10, 0x10, 0x10],
    G: [0x0f, 0x10, 0x10, 0x17, 0x11, 0x11, 0x0f],
    H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
    I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
    J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
    K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
    L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
    M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
    N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
    O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
    P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
    Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
    R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
    S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
    T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
    U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
    V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
    W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
    X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
    Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
    Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
    0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
    1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
    2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
    3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
    4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
    5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
    6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
    7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
    8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
    9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
    " ": [0, 0, 0, 0, 0, 0, 0],
    "[": [0x0e, 0x08, 0x08, 0x08, 0x08, 0x08, 0x0e],
    "]": [0x0e, 0x02, 0x02, 0x02, 0x02, 0x02, 0x0e],
    ",": [0, 0, 0, 0, 0, 0x04, 0x08],
    "-": [0, 0, 0, 0x0e, 0, 0, 0],
    ".": [0, 0, 0, 0, 0, 0x04, 0x04],
};
function _drawText57(buf, W, text, cx, cy, rgb) {
    text = String(text).toUpperCase();
    const chars = [...text].filter((ch) => _FONT57[ch]);
    const w = chars.length * 6 - 1;
    let ox = Math.round(cx - w / 2);
    for (const ch of chars) {
        const gl = _FONT57[ch];
        for (let col = 0; col < 5; col++)
            for (let row = 0; row < 7; row++) {
                if (gl[row] & (1 << col)) {
                    const px = ox + col,
                        py = cy + row;
                    if (px >= 0 && px < W && py >= 0 && py < buf.length / (W * 4)) {
                        const i = (py * W + px) * 4;
                        buf[i] = rgb[0];
                        buf[i + 1] = rgb[1];
                        buf[i + 2] = rgb[2];
                        buf[i + 3] = 255;
                    }
                }
            }
        ox += 6;
    }
}
// TTF text rendering for mob-map labels via opentype.js + scanline rasterizer.
// Uses Arial Bold from Windows fonts; falls back gracefully if unavailable.
let _ttfFont = null;
try {
    const _buf = fs.readFileSync("C:/Windows/Fonts/arialbd.ttf");
    _ttfFont = opentype.parse(_buf.buffer.slice(_buf.byteOffset, _buf.byteOffset + _buf.byteLength));
} catch (e) {
    /* ponytail: windows-only path; bundle a TTF if this must run elsewhere */
}

function _drawTtfText(buf, W, H, text, cx, cyBaseline, fontSize, rgb) {
    if (!_ttfFont) return false;
    const path = _ttfFont.getPath(String(text), 0, 0, fontSize);
    const bb = path.getBoundingBox();
    const ox = Math.round(cx - (bb.x2 - bb.x1) / 2 - bb.x1);
    const oy = Math.round(cyBaseline);
    // flatten to polylines
    const polys = [];
    let cur = null,
        x = 0,
        y = 0,
        sx = 0,
        sy = 0;
    const P = (px, py) => {
        if (!cur) {
            cur = [];
            polys.push(cur);
            sx = px;
            sy = py;
        }
        cur.push([px + ox, py + oy]);
    };
    for (const c of path.commands) {
        if (c.type === "M") {
            cur = null;
            x = c.x;
            y = c.y;
            P(x, y);
        } else if (c.type === "L") {
            x = c.x;
            y = c.y;
            P(x, y);
        } else if (c.type === "C") {
            for (let t = 1; t <= 8; t++) {
                const u = t / 8;
                P(
                    (1 - u) ** 3 * x + 3 * (1 - u) ** 2 * u * c.x1 + 3 * (1 - u) * u * u * c.x2 + u ** 3 * c.x,
                    (1 - u) ** 3 * y + 3 * (1 - u) ** 2 * u * c.y1 + 3 * (1 - u) * u * u * c.y2 + u ** 3 * c.y
                );
            }
            x = c.x;
            y = c.y;
        } else if (c.type === "Q") {
            for (let t = 1; t <= 6; t++) {
                const u = t / 6;
                P(
                    (1 - u) ** 2 * x + 2 * (1 - u) * u * c.x1 + u * u * c.x,
                    (1 - u) ** 2 * y + 2 * (1 - u) * u * c.y1 + u * u * c.y
                );
            }
            x = c.x;
            y = c.y;
        } else if (c.type === "Z") {
            if (cur && cur.length > 2) cur.push([sx + ox, sy + oy]);
            cur = null;
        }
    }
    // even-odd scanline fill
    for (let py = Math.max(0, oy - fontSize); py < Math.min(H, oy + 1); py++) {
        const ys = py + 0.5;
        const xs = [];
        for (const poly of polys) {
            for (let i = 0; i < poly.length - 1; i++) {
                const [x1, y1] = poly[i],
                    [x2, y2] = poly[i + 1];
                if ((y1 <= ys && y2 > ys) || (y2 <= ys && y1 > ys)) xs.push(x1 + ((ys - y1) / (y2 - y1)) * (x2 - x1));
            }
        }
        xs.sort((a, b) => a - b);
        for (let i = 0; i + 1 < xs.length; i += 2) {
            for (let px = Math.max(0, Math.round(xs[i])); px <= Math.min(W - 1, Math.round(xs[i + 1])); px++) {
                const idx = (py * W + px) * 4;
                buf[idx] = rgb[0];
                buf[idx + 1] = rgb[1];
                buf[idx + 2] = rgb[2];
                buf[idx + 3] = 255;
            }
        }
    }
    return true;
}

/**
 * BotRenderable mixin: mob-map image generation and Discord alerting.
 * Methods are copied onto BotSession.prototype by bot_session.js.
 */
class _BotRenderable {
    constructor() {
        /** @type {any} */ this.botX;
    }
    _generateMobMapImage(mob, gridX, gridY) {
        if (!this.mapGrid || this.mapGrid.length === 0) return null;
        const size = 480,
            rows = this.mapGrid.length,
            cols = this.mapGrid[0].length;
        const png = new PNG({ width: size, height: size });
        const px = png.data;
        // background
        for (let i = 0; i < px.length - 3; i += 4) {
            px[i] = 0x0e;
            px[i + 1] = 0x13;
            px[i + 2] = 0x18;
            px[i + 3] = 255;
        }
        // grid cells
        const cellPx = size / Math.max(rows, cols);
        for (let r = 0; r < rows; r++)
            for (let c = 0; c < cols; c++) {
                if (this.mapGrid[r][c] !== 1) continue;
                const x0 = c * cellPx,
                    y0 = r * cellPx;
                const x1 = Math.min(size, Math.round(x0 + cellPx)),
                    y1 = Math.min(size, Math.round(y0 + cellPx));
                for (let y = Math.floor(y0); y < y1; y++)
                    for (let x = Math.floor(x0); x < x1; x++) {
                        const i = (y * size + x) * 4;
                        px[i] = 0x3a;
                        px[i + 1] = 0x44;
                        px[i + 2] = 0x4f;
                        px[i + 3] = 255;
                    }
            }
        // mob dot (filled circle r=5)
        const mx = Math.max(10, Math.min(size - 10, gridX * cellPx + cellPx / 2));
        const my = Math.max(10, Math.min(size - 10, gridY * cellPx + cellPx / 2));
        for (let y = Math.floor(my) - 5; y <= my + 5; y++)
            for (let x = Math.floor(mx) - 5; x <= mx + 5; x++) {
                if (x < 0 || x >= size || y < 0 || y >= size) continue;
                const dx = x - mx,
                    dy = y - my;
                if (dx * dx + dy * dy > 25) continue;
                const i = (y * size + x) * 4;
                px[i] = 0xff;
                px[i + 1] = 0xd7;
                px[i + 2] = 0x00;
                px[i + 3] = 255;
            }
        // labels: name above dot, grid coords below (TTF if available, 5x7 bitmap fallback)
        const vName = this._variantNames[mob.variant] || "";
        const rObj = this._rarities[mob.rarity];
        const label = `${mob.variant === 0 ? "" : vName + " "}${rObj ? rObj.name : ""} ${mob.name}`;
        if (!_drawTtfText(px, size, size, label, mx, my - 10, 18, [0xff, 0xd7, 0x00]))
            _drawText57(px, size, label, mx, my - 10 - 7, [0xff, 0xd7, 0x00]);
        if (!_drawTtfText(px, size, size, `[${gridX},${gridY}]`, mx, my + 10 + 12, 18, [0xff, 0xd7, 0x00]))
            _drawText57(px, size, `[${gridX},${gridY}]`, mx, my + 10, [0xff, 0xd7, 0x00]);
        return /** @type {any} */ (PNG).sync.write(png);
    }
    _sendDiscordAlert(mob) {
        const _tag = `[${this.accountId.slice(0, 8)}]`;
        if (!this.botToken) {
            console.log(`${_tag} [Discord] Skip: no botToken`);
            return;
        }
        const cellSz = this.serverMapSize / this.gridWidth;
        const gridX = Math.floor(mob.x / cellSz),
            gridY = Math.floor(mob.y / cellSz);
        const um = this.serverUrl.match(/s-([a-z]+)-([a-z]+)\./);
        const region = um ? um[1] : "",
            sbiome = um ? um[2] : "";
        const channelId =
            (this.biomeChannels.biomes && this.biomeChannels.biomes[sbiome]) || this.biomeChannels.defaultChannelId;
        if (!channelId) {
            console.log(
                `${_tag} [Discord] Skip: no channel for biome=${sbiome} default=${this.biomeChannels.defaultChannelId}`
            );
            return;
        }
        console.log(
            `${_tag} [Discord] Sending: ${mob.slug} variant=${mob.variant} rarity=${mob.rarity} to channel=${channelId}`
        );
        const vName = this._variantNames[mob.variant] || `V${mob.variant}`;
        const rObj = this._rarities[mob.rarity];
        const rName = rObj ? rObj.name : `R${mob.rarity}`;
        // Build role mention prefix from matching ping rules
        let roleMentions = "";
        if (this.pingRules && this.pingRules.length > 0) {
            const matchedRoles = [];
            for (const rule of this.pingRules) {
                if (rule.slug && mob.slug !== rule.slug) continue;
                if (rule.variants?.length > 0 && !rule.variants.includes(mob.variant)) continue;
                if (rule.rarities?.length > 0 && !rule.rarities.includes(mob.rarity)) continue;
                if (rule.roleId) matchedRoles.push(`<@&${rule.roleId}>`);
            }
            if (matchedRoles.length > 0) roleMentions = matchedRoles.join(" ") + " ";
        }
        const content = `${roleMentions}${rName.toLowerCase()} ${mob.variant === 0 ? "" : vName.toLowerCase() + " "}${mob.name.toLowerCase()} ${region}-${sbiome} ${gridX} ${gridY}`;
        const imgBuf = this._generateMobMapImage(mob, gridX, gridY);
        const apiHost = "discord.com";
        const apiPath = `/api/v10/channels/${channelId}/messages`;
        const auth = `Bot ${this.botToken}`;
        if (imgBuf) {
            const boundary = "----ZorrBot" + Date.now();
            const pre = Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ content })}\r\n`
            );
            const filePart = Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="map.png"\r\nContent-Type: image/png\r\n\r\n`
            );
            const post = Buffer.from(`\r\n--${boundary}--\r\n`);
            const body = Buffer.concat([pre, filePart, imgBuf, post]);
            const req = https.request(
                {
                    hostname: apiHost,
                    port: 443,
                    path: apiPath,
                    method: "POST",
                    headers: {
                        Authorization: auth,
                        "Content-Type": `multipart/form-data; boundary=${boundary}`,
                        "Content-Length": body.length,
                    },
                },
                (res) => {
                    res.resume();
                }
            );
            req.on("error", () => {});
            req.end(body);
        } else {
            const body = JSON.stringify({ content });
            const req = https.request(
                {
                    hostname: apiHost,
                    port: 443,
                    path: apiPath,
                    method: "POST",
                    headers: {
                        Authorization: auth,
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(body),
                    },
                },
                (res) => {
                    res.resume();
                }
            );
            req.on("error", () => {});
            req.end(body);
        }
    }
}
export const BotRenderable = _BotRenderable.prototype;
