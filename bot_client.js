// bot_client_2.js
// A standalone NodeJS WebSocket Bot Client for Zorr.
// This bot connects directly to the game server, handles LCG encryption handshake,
// and logs its own information/equipped status.
//
// Usage: node bot_client_2.js [ServerURL] [PlayerID] [BotName]
// Example: node bot_client_2.js wss://s-as-plains.zorr.pro/ cecb2644-... mybot
//
// Note: The server identifies accounts by PlayerID alone (no auth token required).
//       Legacy versions accepted an optional AuthToken from localStorage "admin_pass",
//       but that key no longer exists in the current game client.

// 1. Auto-install dependency "ws" if missing
try {
    require.resolve('ws');
} catch (e) {
    console.log('\x1b[33m[Bot Client] Missing "ws" package. Installing automatically...\x1b[0m');
    try {
        const { execSync } = require('child_process');
        execSync('npm install ws', { stdio: 'inherit' });
        console.log('\x1b[32m[Bot Client] "ws" successfully installed!\x1b[0m\n');
    } catch (err) {
        console.error('Failed to auto-install "ws". Please run: npm install ws');
        process.exit(1);
    }
}

const WebSocket = require('ws');
const { createCanvas, registerFont } = require('canvas');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const dgram = require('dgram');

const FONT_DIR = path.join(__dirname, 'fonts');
const FONT_PATH = path.join(FONT_DIR, 'Ubuntu-Bold.ttf');
const FONT_FAMILY = 'Ubuntu';

async function ensureUbuntuFont() {
    if (fs.existsSync(FONT_PATH)) {
        registerFont(FONT_PATH, { family: FONT_FAMILY, weight: 'bold' });
        return;
    }
    console.log('[Init] Ubuntu Bold font not found, downloading from Google Fonts...');
    fs.mkdirSync(FONT_DIR, { recursive: true });

    const cssUrl = 'https://fonts.googleapis.com/css2?family=Ubuntu:wght@700';
    const cssBody = await new Promise((resolve, reject) => {
        https.get(cssUrl, { headers: { 'User-Agent': 'Mozilla/4.0' } }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => resolve(data));
            res.on('error', reject);
        }).on('error', reject);
    });

    const m = cssBody.match(/url\((https:[^)]+)\)\s+format\('truetype'\)/);
    if (!m) throw new Error('Could not parse TTF URL from Google Fonts CSS');
    console.log(`[Init] Downloading font: ${m[1]}`);

    const fontBuf = await new Promise((resolve, reject) => {
        https.get(m[1], (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });

    fs.writeFileSync(FONT_PATH, fontBuf);
    console.log(`[Init] Ubuntu Bold font saved (${fontBuf.length} bytes)`);
    registerFont(FONT_PATH, { family: FONT_FAMILY, weight: 'bold' });
}
const { extractProtocolVersion } = require('./protocol_extractor');

// SSE control stream: state/equip changes pushed immediately from map_server
// (Replaces the 2s pollCommand latency for time-sensitive operations.)
let _controlStreamReq = null;
let _controlStreamReconnectTimer = null;
let _controlStreamConnected = false;        // Current connection state
let _controlStreamBackoffMs = 2000;         // Current backoff (doubles on each failure, caps at 30s)
let _controlDiscoveryMode = false;          // true = waiting for UDP hello, false = retry with backoff
let _controlDiscoverySocket = null;         // UDP listener for map_server "hello" packets
const _CONTROL_BACKOFF_INITIAL_MS = 2000;
const _CONTROL_BACKOFF_MAX_MS = 30000;
const CONTROL_DISCOVERY_PORT = 41235;       // Must match map_server.js CONTROL_DISCOVERY_PORT

// Map server broadcasting (throttled + keep-alive for performance)
const MAP_SERVER_URL = 'http://localhost:3000';
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 2 });

// Tracking config (from map_server SSE push)
let trackingTargets = [];
let trackingWebhookUrl = process.env.DISCORD_WEBHOOK_URL || '';
const notifiedMobs = []; // Notified mob cooldown: [{name, variant, rarity, gridX, gridY}]

// Throttle: buffer latest data per type, flush at max 10fps (100ms)
const _broadcastBuffer = {};
let _broadcastTimer = null;
// Track broadcast connectivity for de-spamming logs: log only the first
// failure (and a single "recovered" message on the next success).
let _broadcastDown = false;
function broadcastMapData(data) {
    // During a server switch, suppress all broadcasts. The bot may still
    // receive buffered entity updates from the old WS between the close
    // request and the actual TCP close — without this guard, those would
    // re-populate the viewer's map_server state with the previous server's
    // mobs and re-render them as "ghost" mobs on the new map.
    if (_switching) return;
    _broadcastBuffer[data.type] = data;
    if (!_broadcastTimer) {
        _broadcastTimer = setTimeout(_flushBroadcast, 100);
    }
}
function _flushBroadcast() {
    _broadcastTimer = null;
    const types = Object.keys(_broadcastBuffer);
    for (const type of types) {
        const data = _broadcastBuffer[type];
        delete _broadcastBuffer[type];
        const postData = JSON.stringify(data);
        const req = http.request({
            hostname: 'localhost',
            port: 3000,
            path: '/mapdata',
            method: 'POST',
            // Fresh connection per request (no keep-alive). The shared
            // keep-alive agent's idle sockets get killed by the map_server's
            // keepAliveTimeout, causing ECONNRESET on the next POST. A short-
            // lived request like this is cheap enough to skip pooling.
            agent: false,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
        });
        let settled = false;
        req.on('response', (res) => {
            settled = true;
            res.resume();
            if (_broadcastDown) {
                _broadcastDown = false;
                console.log('\x1b[32m[Broadcast] POST /mapdata recovered\x1b[0m');
            }
        });
        req.on('error', (e) => {
            if (settled) return; // ignore post-response errors
            if (!_broadcastDown) {
                _broadcastDown = true;
                console.log(`\x1b[33m[Broadcast] POST /mapdata failed: ${e.message} (will retry silently until success)\x1b[0m`);
            }
            // Re-buffer so a subsequent tick retries
            _broadcastBuffer[type] = data;
            if (!_broadcastTimer) {
                _broadcastTimer = setTimeout(_flushBroadcast, 2000);
            }
        });
        req.end(postData);
    }
}

// Discord webhook alert for tracked mobs
const _VARIANT_NAMES = ['Normal','Magic','Arcane','Cursed','Shiny','Corrupt','Radiant','Giant','Tiny','Charged','Elemental','Angelic','Demonic','Bloody','Sweet','Paranormal','Flash','Boss'];

function generateMobMapImage(mob, gridX, gridY) {
    if (!mapGrid || mapGrid.length === 0) return null;
    const size = 480;
    const rows = mapGrid.length;
    const cols = mapGrid[0].length;
    const cellPx = size / Math.max(rows, cols);
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0e1318';
    ctx.fillRect(0, 0, size, size);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            ctx.fillStyle = mapGrid[r][c] === 1 ? '#3a444f' : '#1a2028';
            ctx.fillRect(c * cellPx, r * cellPx, cellPx, cellPx);
        }
    }
    const mx = Math.max(10, Math.min(size - 10, gridX * cellPx + cellPx / 2));
    const my = Math.max(10, Math.min(size - 10, gridY * cellPx + cellPx / 2));
    ctx.beginPath();
    ctx.arc(mx, my, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd700';
    ctx.fill();
    const variantName = _VARIANT_NAMES[mob.variant] || '';
    const rarityObj = rarities[mob.rarity];
    const rarityName = rarityObj ? rarityObj.name : '';
    const variantPart = mob.variant === 0 ? '' : `${variantName} `;
    const label = `${variantPart}${rarityName} ${mob.name}`;
    ctx.font = 'bold 18px Ubuntu, monospace';
    ctx.fillStyle = '#ffd700';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, mx, my - 10);
    ctx.textBaseline = 'top';
    ctx.fillText(`[${gridX},${gridY}]`, mx, my + 10);
    return canvas.toBuffer('image/png');
}

function sendDiscordAlert(mob) {
    if (!trackingWebhookUrl) return;
    const variantName = _VARIANT_NAMES[mob.variant] || `Variant_${mob.variant}`;
    const rarityObj = rarities[mob.rarity];
    const rarityName = rarityObj ? rarityObj.name : `Rarity_${mob.rarity}`;
    const cellSz = serverMapSize / gridWidth;
    const gridX = Math.floor(mob.x / cellSz);
    const gridY = Math.floor(mob.y / cellSz);
    const _uMatch = serverUrl.match(/s-([a-z]+)-([a-z]+)\./);
    const region = _uMatch ? _uMatch[1] : '';
    const serverBiome = _uMatch ? _uMatch[2] : '';
    const variantPart = mob.variant === 0 ? '' : `${variantName.toLowerCase()} `;
    const content = `<@&1473497061981683876> ${rarityName.toLowerCase()} ${variantPart}${mob.name.toLowerCase()} ${region}-${serverBiome} ${gridX} ${gridY}`;
    const imgBuf = generateMobMapImage(mob, gridX, gridY);
    if (!imgBuf) {
        const body = JSON.stringify({ content });
        const req = https.request({
            hostname: 'discord.com',
            port: 443,
            path: new URL(trackingWebhookUrl).pathname,
            method: 'POST',
            agent: false,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => { res.resume(); });
        req.on('error', () => {});
        req.end(body);
        return;
    }
    const boundary = '----ZorrBot' + Date.now().toString(36);
    const payloadJson = JSON.stringify({ content });
    const parts = [
        `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${payloadJson}\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="map_${gridX}_${gridY}.png"\r\nContent-Type: image/png\r\n\r\n`,
    ];
    const footer = `\r\n--${boundary}--\r\n`;
    const partsBuf = Buffer.concat([
        Buffer.from(parts[0]),
        Buffer.from(parts[1]),
        imgBuf,
        Buffer.from(footer)
    ]);
    const req = https.request({
        hostname: 'discord.com',
        port: 443,
        path: new URL(trackingWebhookUrl).pathname,
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': partsBuf.length }
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.end(partsBuf);
}

// 2. Command Line Arguments & Defaults
let serverUrl = process.argv[2] || "wss://s-us-plains.zorr.pro/";
const specifiedPlayerId = process.argv[3] || "dd6d4c29-87ba-47e3-bd23-49e3551d76d1";
const botName = process.argv[4] || "pinky pinky"; // Bot's display name (empty = random)
// 3. LCG (Linear Congruential Generator) Encryption Class
// Matches the exact client implementation from zorr-deobfuscated.js line 1255-1263
class LCG {
    constructor(seed) {
        this.seed = seed >>> 0;
    }
    // Generate next pseudorandom byte for XOR key stream
    // MUST match: this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
    //             return Math.floor(this.seed / 4294967296 * 255);
    next() {
        this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
        return Math.floor(this.seed / 4294967296 * 255);
    }
}

// MinHeap for A* pathfinding optimization (O(log n) insert/extract vs O(n log n) sort)
class MinHeap {
    constructor() { this.data = []; }
    get size() { return this.data.length; }
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
                const l = 2 * i + 1, r = 2 * i + 2;
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

// 4. Client State Variables
let ws = null;
let _switching = false; // Re-entrancy guard for server switches
let _lastMapBroadcast = 0;
// Connection generation: (epoch, counter) pair. The counter wraps at 10
// (so it never grows large in long-running processes) and the epoch
// bumps whenever the counter wraps, guaranteeing that any close handler
// from a superseded connection is detected by an epoch mismatch.
let _connectEpoch = 0;
let _connectCounter = 0;

function _bumpGeneration() {
    _connectCounter = (_connectCounter + 1) % 10;
    if (_connectCounter === 0) _connectEpoch++;
}

/**
 * Build a Zorr game-server WebSocket URL from region/biome and optional
 * lobby hash. Used by both the initial connect (with no hash) and the
 * dynamic switch command (with optional hash).
 */
function buildServerUrl(region, biome, hash) {
    let url = `wss://s-${region}-${biome}.zorr.pro/`;
    if (hash) url += hash;
    return url;
}

/**
 * Switch the bot to a different game server. Closes the current WS,
 * updates serverUrl, and reconnects after a brief settle window so the
 * server side can clean up the old session. No-op if a switch is already
 * in progress.
 */
function switchBotServer(region, biome) {
    if (_switching) {
        console.log(`\x1b[33m[Switch] Already switching; ignoring ${region}/${biome}\x1b[0m`);
        return;
    }
    notifiedMobs.length = 0; // Reset cooldown list on server switch
    _switching = true;
    // Notify map_server so it broadcasts {type:'switch'} to all web UIs
    try {
        const postData = JSON.stringify({ type: 'switch', region, biome });
        http.request({ hostname: 'localhost', port: 3000, path: '/mapdata', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
        }, (res) => { res.resume(); }).on('error', () => {}).end(postData);
    } catch (_) {}
    // Flush pending stale broadcasts from the old server
    for (const type of Object.keys(_broadcastBuffer)) {
        delete _broadcastBuffer[type];
    }
    if (_broadcastTimer) {
        clearTimeout(_broadcastTimer);
        _broadcastTimer = null;
    }
    const newUrl = buildServerUrl(region, biome);
    console.log(`\x1b[35m[Switch] ${serverUrl} -> ${newUrl}\x1b[0m`);
    serverUrl = newUrl;
    // Bump the generation BEFORE closing the old socket. The old socket's
    // close handler will see the mismatch and skip its 5-second
    // auto-reconnect, preventing a phantom second connection to the
    // same server (which would get kicked for tooManyConnections).
    _bumpGeneration();
    const oldWs = ws;
    if (oldWs) {
        let reconnected = false;
        const onClosed = () => {
            if (reconnected) return;
            reconnected = true;
            // Reset state and reconnect
            cleanup();
            setTimeout(() => {
                _switching = false;
                connect();
            }, 1000);
        };
        oldWs.once('close', onClosed);
        try { oldWs.close(); } catch (_) { onClosed(); }
    } else {
        _switching = false;
        connect();
    }
}
let encryptor = null; // LCG instance — shared across handshake & game packets
let botId = null;     // Bot's own Entity ID (received from server)
let botX = 0;
let botY = 0;

let botStats = null;     // Bot's own player statistics
let activePetals = new Map(); // Track all active petals on the map: Entity ID -> Petal Object
let botEquippedPetals = []; // Bot's equipped petals parsed from login packet
let botEquippedTalents = []; // Bot's active talent slugs

// Dynamic game data (populated at startup from game source)
let petalNames = [];
let slugToId = {}; // slug→ID map built from petalNames
let mobNames = [];
let mobSlugs = [];
let rarities = [];
let snakeMobIndices = new Set();

let isSpawned = false;
let isDead = false;
let respawnState = ''; // '' | 'die_sent' | 'spawn_sent'
let returnToTitle = false; // true = stay on title screen after opcode 5 (no auto-respawn)
let pingInterval = null;
let movementInterval = null;
let pollInterval = null;   // Poll interval for map viewer commands (fixed leak)
let lcgBytesSent = 0; // Track total LCG bytes consumed for stream integrity check
let equipSentTime = null; // Track when equip was sent for response monitoring
let botInventory = {};    // Current inventory: { petalKey: count }

// Pinky state detection (bitmask 2048 in entity status flags)
// Dynamically verified from game source using regex: .prop = !!(2048 & var)
let PINKY_BITMASK = 2048;  // Default, verified at startup from game source
let isPinky = false;       // Current pinky state

// Protocol version (dynamically extracted from game source at startup)
let protocolVersion = 443; // Fallback default; overwritten by VM extraction in init()

// Map info (populated from login packet)
let mapName = '';
let biomeName = '';
let gridWidth = 0;
let mapGrid = null; // 2D array: 0 = empty, 1 = wall
let cellSize = 500; // Default cell size
let serverMapSize = 100000; // mapSize from server (ey)
let streakData = { count: 0, lastClaimTime: 0, nextClaimDeadline: 0 };

// Opcode Constants (from R enum in zorr-deobfuscated.js)
// Second block of M({ zn:0, On:1, Bn:2, Un:3, _n:4, Gn:5, ... })
const OPCODE_SEND = {
    HANDSHAKE: 0,  // R.zn (first block Pe=0 but handshake uses R[u(395)] which resolves to 0)
    PING: 1,       // R.On — sent every 1 second
    SPAWN_PLAY: 2, // R.Bn — kY(R.Bn, name) to join game with a name
    DIE_QUIT: 3,   // R.Un — t5(R.Un) to die/respawn/quit
    UNKNOWN_4: 4,  // R._n
    MOVEMENT: 5,   // R.Gn — sent every frame (~16ms)
    EQUIP_LOADOUT: 72, // R.no — ji() function
    TALENT_RESET: 122, // R.$o — hx.resetTalents() → t8(R.$o)
    TALENT_APPLY: 123, // R.ei — hx.wc(t) → t8(R.ei, t.id)
    CLAIM_STREAK: 16,  // R.na — daily streak claim (ta(R.na))
};

// Talent slug → ID mapping (from talent_data.js, order matches game's eg[] array)
const _talentData = require('./talent_data');
const talentSlugToId = {};
for (const t of _talentData) {
    talentSlugToId[t.slug] = t.id;
}

// Build decode constants (from zorr-deobfuscated.js)
const BUILD_MAGIC = 1;
const BUILD_AX = 32; // petalId * AX + rarity

// Decode a build code string (base64) → build object
function decodeBuildCode(b64) {
    const raw = Buffer.from(b64, 'base64');
    if (raw.length < 8) return null;
    const magic = raw.readUInt32BE(0);
    if (magic !== BUILD_MAGIC) return null;
    const seed = raw.readUInt32BE(4);
    const data = raw.subarray(8);

    // LCG matching game's T class
    let lcgState = seed >>> 0;
    function lcgNext() {
        lcgState = (Math.imul(lcgState, 1664525) + 1013904223) >>> 0;
        return Math.floor(lcgState / 4294967296 * 255);
    }

    // XOR with 2 LCG bytes per data byte
    for (let i = 0; i < data.length; i++) {
        data[i] ^= lcgNext() ^ lcgNext();
    }
    // Swap adjacent bytes
    for (let i = 0; i < data.length - 1; i += 2) {
        const tmp = data[i];
        data[i] = data[i + 1];
        data[i + 1] = tmp;
    }
    const jsonStr = new TextDecoder().decode(data);
    return JSON.parse(jsonStr);
}



// Encode a build object into opcode 72 packet and send it
function sendTalentReset() {
    if (!isSpawned) return;
    const packet = new Uint8Array([OPCODE_SEND.TALENT_RESET]);
    sendEncrypted(packet);
    console.log(`\x1b[36m[Bot] Sent talent reset (opcode 122)\x1b[0m`);
}

function sendTalentApply(talentId) {
    if (!isSpawned) return;
    const packet = new Uint8Array([OPCODE_SEND.TALENT_APPLY, talentId]);
    sendEncrypted(packet);
}

function sendTalents(talentSlugs) {
    if (!Array.isArray(talentSlugs) || talentSlugs.length === 0) return;
    // 1. Reset all talents first
    sendTalentReset();
    // 2. Apply each talent in order (parent before child is handled by game server)
    let applied = 0;
    for (const slug of talentSlugs) {
        const id = talentSlugToId[slug];
        if (id !== undefined) {
            sendTalentApply(id);
            applied++;
        } else {
            console.log(`\x1b[33m[Bot] Unknown talent slug: "${slug}"\x1b[0m`);
        }
    }
    console.log(`\x1b[36m[Bot] Sent ${applied}/${talentSlugs.length} talents\x1b[0m`);
    // Store locally for broadcasts
    botEquippedTalents = talentSlugs;
}

function sendEquipLoadout(buildObj) {
    if (!isSpawned) {
        console.log('\x1b[33m[Bot] Cannot equip: not spawned\x1b[0m');
        return;
    }

    // Use slug→ID map built from extracted game data

    // Encode per ji() at zorr-deobfuscated.js line 29235
    // Packet: [opcode=72] [hasBottomRow] [topRow.length] [petalData(2 bytes each)] [bottomRow petalData(2 bytes each)]
    const topRow = buildObj.topRow || [];
    const bottomRow = buildObj.bottomRow || null;
    const hasBottom = bottomRow ? 1 : 0;
    const slotCount = topRow.length;

    // Total size: 3 header bytes + topRow * 2 + (bottomRow ? bottomRow * 2 : 0)
    const totalSize = 3 + topRow.length * 2 + (bottomRow ? bottomRow.length * 2 : 0);
    const packet = new Uint8Array(totalSize);
    const view = new DataView(packet.buffer);
    let offset = 0;
    view.setUint8(offset++, OPCODE_SEND.EQUIP_LOADOUT);
    view.setUint8(offset++, hasBottom);
    view.setUint8(offset++, slotCount);

    function encodeRow(row) {
        for (const entry of row) {
            let value = 0;
            if (entry) {
                const [slug, rarity] = entry;
                const petalId = slugToId[slug];
                if (petalId !== undefined) {
                    value = petalId * BUILD_AX + rarity + 1; // ay(e.id, n) + 1
                } else {
                    console.log(`\x1b[33m[Bot] Unknown petal slug: "${slug}"\x1b[0m`);
                }
            }
            view.setUint16(offset, value);
            offset += 2;
        }
    }

    encodeRow(topRow);
    if (bottomRow) encodeRow(bottomRow);

    sendEncrypted(packet);
    equipSentTime = Date.now();
    const hex = Array.from(packet).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    console.log(`\x1b[36m[Bot] Sent equip loadout (${topRow.length} top + ${bottomRow ? bottomRow.length : 0} bottom slots)\x1b[0m`);

    // Update local equipped petals list so the map viewer reflects changes immediately
    const newPetals = [];
    function addRowEntry(entry) {
        if (!entry) return;
        const [slug, rarityIdx] = entry;
        const petalName = petalNames[slugToId[slug]] || slug;
        const rarityName = rarities[rarityIdx]?.name || `R${rarityIdx}`;
        newPetals.push({ petalName, rarityName });
    }
    for (const entry of topRow) addRowEntry(entry);
    if (bottomRow) for (const entry of bottomRow) addRowEntry(entry);
    botEquippedPetals = newPetals;
    console.log(`\x1b[36m[Bot] Local petals updated: ${newPetals.map(p => `${p.rarityName} ${p.petalName}`).join(', ')}\x1b[0m`);

    // Force an immediate position broadcast so the map viewer updates right away
    broadcastMapData({ type: 'position', session: _currentSessionId, x: botX, y: botY, petals: botEquippedPetals, talents: buildObj.talents || [], hp: botStats?.hpPercent, mana: botStats?.manaPercent, level: botStats?.level, isPinky, navPath: navPath.length > 0 ? navPath : undefined });

    // Send talent packets to server (after petals, as the game client does)
    if (buildObj.talents && buildObj.talents.length > 0) {
        sendTalents(buildObj.talents);
    }
}

// Helper to convert Uint8Array to clean hex string
function toHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

// Connect to Game Server WebSocket
function connect() {
    // Bump generation and capture (epoch, counter) so this connect's
    // close handler can detect when it has been superseded by a newer
    // connect (auto-reconnect or switch).
    _bumpGeneration();
    _currentSessionId++;  // Bump session ID for each connect so the viewer
                          // can identify and filter out broadcasts from
                          // the previous (switched-out) server.
    const myEpoch = _connectEpoch;
    const myCounter = _connectCounter;
    console.log(`[Bot] Connecting to ${serverUrl}... (gen=${myEpoch}:${myCounter}, session=${_currentSessionId})`);
    ws = new WebSocket(serverUrl, {
        origin: 'https://zorr.pro',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });

    ws.on('open', () => {
        console.log('\x1b[32m[Bot] TCP Connection Established. Initiating Handshake...\x1b[0m');
        sendHandshake();
    });

    ws.on('message', (data) => {
        const bytes = new Uint8Array(data);
        handleMessage(bytes);
    });

    ws.on('close', (code, reason) => {
        // If a newer connect (auto-reconnect, switch, or external trigger)
        // has been started since this socket was opened, do nothing here.
        // The newer connect owns the lifecycle now; scheduling another
        // reconnect would create a phantom second connection.
        if (myEpoch !== _connectEpoch || myCounter !== _connectCounter) {
            console.log(`\x1b[33m[Bot] Stale close on gen ${myEpoch}:${myCounter} (current ${_connectEpoch}:${_connectCounter}); ignoring\x1b[0m`);
            return;
        }
        console.log(`\x1b[31m[Bot] Connection closed. Code: ${code}, Reason: ${reason || 'N/A'}. Reconnecting in 5 seconds...\x1b[0m`);
        cleanup();
        setTimeout(connect, 5000);
    });

    ws.on('error', (err) => {
        console.error('[Bot] WebSocket Error:', err.message);
    });
}

// Clean up loops on disconnect
function cleanup() {
    if (pingInterval) clearInterval(pingInterval);
    if (movementInterval) clearInterval(movementInterval);
    if (pollInterval) clearInterval(pollInterval);
    pingInterval = null;
    movementInterval = null;
    pollInterval = null;
    isSpawned = false;
    loggedIn = false;
    spawnSent = false;
    isDead = false;
    respawnState = '';
    receivedOpcodes = new Set();
    botId = null;
    botX = 0;
    botY = 0;
    botStats = null;
    activePetals.clear();
    activeMobs.clear();      // Drop all mobs from the previous map so the
                             // next parseEntityUpdates doesn't re-broadcast
                             // them on the new server connection.
    knownEntities.clear();   // Drop all known entities too (spawned + tracked).
    botOutlierCount = 0;
    botEquippedPetals = [];
    botInventory = {};
    notifiedMobs.length = 0; // Reset cooldown list on disconnect
    navRoute = [];
    navRouteIndex = 0;
}

// 5. Send Handshake (Opcode 0)
// SSE control stream: parse incoming event-stream from map_server's /control-stream
// Events: 'state' (attack/defend toggle), 'equip' (immediate equip command)
let _pendingEquipCmd = null;
let _pendingEquipRetryTimer = null;

function _processPendingEquip() {
    if (!_pendingEquipCmd) return;
    if (!isSpawned) {
        // Wait for spawn; retry shortly (do NOT block other commands)
        if (_pendingEquipRetryTimer) return;
        _pendingEquipRetryTimer = setTimeout(() => {
            _pendingEquipRetryTimer = null;
            _processPendingEquip();
        }, 200);
        return;
    }
    const cmd = _pendingEquipCmd;
    _pendingEquipCmd = null;
    try {
        if (cmd.buildCode) {
            const build = decodeBuildCode(cmd.buildCode);
            if (build) {
                // Merge talents from cmd into the build object
                if (cmd.talents && cmd.talents.length > 0) build.talents = cmd.talents;
                sendEquipLoadout(build);
            } else console.log('\x1b[33m[Bot] Invalid build code\x1b[0m');
        } else {
            const filePath = path.join(__dirname, cmd.buildFile || 'loadouts/move.txt');
            const b64 = fs.readFileSync(filePath, 'utf8').trim();
            const build = decodeBuildCode(b64);
            if (build) {
                // Merge talents from cmd into the build object
                if (cmd.talents && cmd.talents.length > 0) build.talents = cmd.talents;
                sendEquipLoadout(build);
            } else console.log('\x1b[33m[Bot] Invalid build file\x1b[0m');
        }
    } catch (e) {
        console.log(`\x1b[33m[Bot] Equip error: ${e.message}\x1b[0m`);
    }
}

function handleControlEvent(eventName, data) {
    if (eventName === 'state') {
        const s = data;
        if ((s.attack ?? false) !== serverAttackToggled || (s.defend ?? false) !== serverDefendToggled) {
            console.log(`\x1b[33m[Action] Server state changed (push): attack=${s.attack} defend=${s.defend}\x1b[0m`);
            serverAttackToggled = !!s.attack;
            serverDefendToggled = !!s.defend;
        }
    } else if (eventName === 'equip') {
        const cmd = data;
        console.log(`\x1b[33m[Bot] Equip command received (push): ${cmd.buildFile || '(inline code)'}\x1b[0m`);
        // Replace any pending equip (only the latest matters)
        _pendingEquipCmd = cmd;
        _processPendingEquip();
    } else if (eventName === 'navigate') {
        const cmd = data;
        if (cmd.action === 'stop') {
            console.log(`\x1b[36m[Nav] Stop command received (push)\x1b[0m`);
            navRoute = [];
            navRouteIndex = 0;
            navPath = [];
            navigateTarget = null;
            sendMovement(0, 0);
            return;
        }
        console.log(`\x1b[36m[Nav] New target (push): (${cmd.x}, ${cmd.y})\x1b[0m`);
        navigateTarget = { x: cmd.x, y: cmd.y };
        fetch(new URL('/ack', MAP_SERVER_URL), { method: 'POST' }).catch(() => { });
        computePath();
    } else if (eventName === 'tracking') {
        const cfg = data;
        trackingTargets = cfg.targets || [];
        if (cfg.webhookUrl) trackingWebhookUrl = cfg.webhookUrl;
        console.log(`\x1b[36m[Tracking] Config updated: ${trackingTargets.length} targets\x1b[0m`);
    } else if (eventName === 'patrol') {
        const route = data.route || [];
        if (route.length > 0) {
            console.log(`\x1b[36m[Patrol] Route received (push): ${route.length} waypoints\x1b[0m`);
            navRoute = route;
            navRouteIndex = 0;
            navigateTarget = { x: route[0].x, y: route[0].y };
            computePath();
        }
        fetch(new URL('/ack', MAP_SERVER_URL), { method: 'POST' }).catch(() => { });
    } else if (eventName === 'command') {
        const cmd = data;
        if (cmd.action === 'title') {
            console.log(`\x1b[35m[Bot] Title command received (push)\x1b[0m`);
            if (!isDead && !respawnState && !returnToTitle) {
                isDead = true;
                isSpawned = false;
                navPath = [];
                navigateTarget = null;
                returnToTitle = true;
                respawnState = 'die_sent';
                sendDie();
            }
        } else if (cmd.action === 'spawn') {
            console.log(`\x1b[32m[Bot] Spawn command received (push)\x1b[0m`);
            returnToTitle = false;
            if (!isSpawned && respawnState !== 'spawn_sent') {
                sendSpawn(botName);
                respawnState = 'spawn_sent';
            }
        } else if (cmd.action === 'death') {
            console.log(`\x1b[33m[Bot] Death command received (push)\x1b[0m`);
            if (!isDead && !respawnState) {
                isDead = true;
                isSpawned = false;
                navPath = [];
                navigateTarget = null;
                respawnState = 'die_sent';
                sendDie();
            }
        }
    } else if (eventName === 'auto-patrol') {
        const cmd = data;
        if (cmd.action === 'start' && cmd.servers) {
            console.log(`\x1b[36m[AutoPatrol] Start command received (push): ${cmd.servers.length} servers\x1b[0m`);
            apStart(cmd.servers);
        } else if (cmd.action === 'stop') {
            console.log(`\x1b[36m[AutoPatrol] Stop command received (push)\x1b[0m`);
            apStop();
        }
    } else if (eventName === 'daily-claim') {
        console.log(`\x1b[33m[Bot] Daily claim command received (push)\x1b[0m`);
        sendClaimStreak();
    }
}

function connectControlStream(serverUrl) {
    if (_controlStreamReq) {
        try { _controlStreamReq.destroy(); } catch (e) { /* ignore */ }
    }
    if (_controlStreamReconnectTimer && !_controlDiscoveryMode) {
        clearTimeout(_controlStreamReconnectTimer);
        _controlStreamReconnectTimer = null;
    }
    const baseUrl = serverUrl || MAP_SERVER_URL;
    const url = new URL('/control-stream', baseUrl);
    const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        agent: httpAgent,
        headers: {
            'Accept': 'text/event-stream',
            'Cache-Control': 'no-store',
            'Connection': 'keep-alive',
        }
    }, (res) => {
        if (res.statusCode !== 200) {
            // HTTP-level error (e.g. 404 if endpoint missing) — log once
            console.log(`\x1b[33m[Control] Stream connect failed: HTTP ${res.statusCode}\x1b[0m`);
            res.resume();
            onStreamClosed(false); // never connected, so no log
            return;
        }
        // Connected — reset backoff and announce once
        if (!_controlStreamConnected) {
            console.log('\x1b[32m[Control] Stream connected to map_server\x1b[0m');
        }
        _controlStreamConnected = true;
        _controlStreamBackoffMs = _CONTROL_BACKOFF_INITIAL_MS;
        let buffer = '';
        let currentEvent = 'message';
        let cleanupDone = false; // de-dupe across end/close/error
        const onStreamClosed = (wasConnected) => {
            if (cleanupDone) return;
            cleanupDone = true;
            if (wasConnected) {
                if (_controlDiscoveryMode) {
                    console.log('\x1b[33m[Control] Stream closed, waiting for next hello from map_server\x1b[0m');
                } else {
                    console.log('\x1b[33m[Control] Stream closed, will reconnect\x1b[0m');
                }
            }
            _controlStreamConnected = false;
            if (_controlStreamReq === req) _controlStreamReq = null;
            scheduleControlReconnect();
        };
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
            buffer += chunk;
            let idx;
            while ((idx = buffer.indexOf('\n\n')) !== -1) {
                const raw = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                currentEvent = 'message';
                let dataLines = [];
                for (const line of raw.split('\n')) {
                    if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
                    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
                }
                if (dataLines.length === 0) continue;
                try {
                    const parsed = JSON.parse(dataLines.join('\n'));
                    handleControlEvent(currentEvent, parsed);
                } catch (e) {
                    /* ignore parse errors */
                }
            }
        });
        // 'close' fires for both clean FIN and RST; 'end' only fires for clean close.
        // Cover all teardown paths and converge to onStreamClosed.
        res.on('end', () => onStreamClosed(true));
        res.on('close', () => onStreamClosed(true));
        res.on('error', (e) => {
            if (_controlStreamConnected) {
                console.log(`\x1b[33m[Control] Stream error: ${e.message}\x1b[0m`);
            }
            _controlStreamConnected = false;
            onStreamClosed(true);
        });
    });
    req.on('error', (e) => {
        // In discovery mode: silent. Just wait for next hello.
        // In retry mode: log non-ECONNREFUSED errors once.
        if (!_controlDiscoveryMode) {
            const isConnectionRefused = e.code === 'ECONNREFUSED';
            if (!isConnectionRefused) {
                console.log(`\x1b[33m[Control] Stream request error: ${e.message}\x1b[0m`);
            }
        }
        _controlStreamConnected = false;
        scheduleControlReconnect();
    });
    req.end();
    _controlStreamReq = req;
}

// Start UDP listener for map_server "hello" broadcasts.
// In discovery mode, bot does not retry — it waits passively for hello packets.
function startControlDiscoveryListener() {
    const socket = dgram.createSocket('udp4');
    let bound = false;
    socket.on('error', (e) => {
        if (!bound) {
            if (e.code === 'EADDRINUSE') {
                console.log(`\x1b[33m[Control] Discovery port ${CONTROL_DISCOVERY_PORT} in use; another bot may already be listening. Falling back to retry mode.\x1b[0m`);
            } else {
                console.log(`\x1b[33m[Control] Discovery listener error: ${e.message}; falling back to retry mode.\x1b[0m`);
            }
            _controlDiscoverySocket = null;
            scheduleControlReconnect();
        }
    });
    socket.on('message', (buf, rinfo) => {
        try {
            const parsed = JSON.parse(buf.toString('utf8'));
            if (parsed.type !== 'zorr-control-hello' || typeof parsed.url !== 'string') return;
            _controlDiscoveryMode = true;
            // If already connected, ignore hello (avoids reconnect churn)
            if (_controlStreamConnected) return;
            // Cancel any pending retry timer; we're now in discovery mode
            if (_controlStreamReconnectTimer) {
                clearTimeout(_controlStreamReconnectTimer);
                _controlStreamReconnectTimer = null;
            }
            connectControlStream(parsed.url);
        } catch (e) {
            /* ignore malformed */
        }
    });
    socket.bind(CONTROL_DISCOVERY_PORT, '127.0.0.1', () => {
        bound = true;
        _controlDiscoverySocket = socket;
        _controlDiscoveryMode = true;
        console.log(`\x1b[36m[Control] Listening for map_server discovery on UDP 127.0.0.1:${CONTROL_DISCOVERY_PORT}\x1b[0m`);
    });
}

function scheduleControlReconnect() {
    // In discovery mode, do not retry — just wait for the next UDP hello.
    if (_controlDiscoveryMode) return;
    if (_controlStreamReconnectTimer) return;
    const delay = _controlStreamBackoffMs;
    // Double the backoff for next time (cap at max)
    _controlStreamBackoffMs = Math.min(_controlStreamBackoffMs * 2, _CONTROL_BACKOFF_MAX_MS);
    _controlStreamReconnectTimer = setTimeout(() => {
        _controlStreamReconnectTimer = null;
        connectControlStream();
    }, delay);
}

// Based on t1() function in zorr-deobfuscated.js lines 42409-43096
// Packet layout: [Opcode(1)] [Protocol(4)] [Seed(4)] [AuthBytes(20)] [UUID(36)]
function sendHandshake() {
    // Generate random 32-bit seed (same as Math.floor(Math.random() * 2**32))
    const seed = Math.floor(Math.random() * 4294967296);

    // Create LCG with this seed — this instance persists for the ENTIRE connection
    encryptor = new LCG(seed);

    // Generate Player ID (UUID)
    const playerId = specifiedPlayerId || crypto.randomUUID();
    const playerIdBytes = Buffer.from(playerId, 'ascii');

    // Build handshake packet
    const packetSize = 1 + 4 + 4 + 20 + playerIdBytes.length;
    const packet = new Uint8Array(packetSize);
    const view = new DataView(packet.buffer);

    let y = 0;
    view.setUint8(y++, OPCODE_SEND.HANDSHAKE);  // Opcode 0
    view.setUint32(y, protocolVersion);             // Protocol version (dynamic)
    y += 4;
    view.setUint32(y, seed);                      // Share LCG seed
    y += 4;

    // Generate 20 auth/verification bytes using LCG
    // IMPORTANT: These next() calls advance the LCG state.
    // The encryptor is NOT reset after this — subsequent game packets
    // continue from this state (byte 21, 22, 23, ... onward)
    for (let i = 0; i < 20; i++) {
        view.setUint8(y++, encryptor.next());
    }

    // Append Player UUID bytes
    packet.set(playerIdBytes, y);
    y += playerIdBytes.length;

    // Handshake is sent UNENCRYPTED (raw, no XOR)
    ws.send(packet);
    console.log(`[Handshake] Sent init packet. Size: ${packet.length} bytes. Seed: 0x${seed.toString(16).toUpperCase()}`);
    console.log(`  Player ID: "${playerId}"`);

    // NOTE: Do NOT reset the encryptor here!
    // The LCG state after 20 auth bytes is the starting state for encrypted packets.
}

// Helper to encrypt and transmit packet via LCG key stream
// Matches t4() in zorr-deobfuscated.js line 43106-43117
function sendEncrypted(packet) {
    if (!encryptor || !ws || ws.readyState !== WebSocket.OPEN) return;

    const lcgBefore = encryptor.seed;
    const encrypted = new Uint8Array(packet.length);
    for (let i = 0; i < packet.length; i++) {
        encrypted[i] = packet[i] ^ encryptor.next();
    }
    ws.send(encrypted);
    lcgBytesSent += packet.length;

    // Log encryption details for opcode 72 only
    if (packet[0] === 72) {
        const plainHex = Array.from(packet).map(b => b.toString(16).padStart(2, '0')).join(' ');
        const encHex = Array.from(encrypted).map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`\x1b[31m[Encrypt] opcode 72 DETAIL:\x1b[0m`);
        console.log(`\x1b[31m  LCG seed before: 0x${lcgBefore.toString(16).toUpperCase()}\x1b[0m`);
        console.log(`\x1b[31m  Plain:  ${plainHex}\x1b[0m`);
        console.log(`\x1b[31m  Enc:    ${encHex}\x1b[0m`);
        console.log(`\x1b[31m  Bytes:  ${packet.length} plain -> ${encrypted.length} encrypted\x1b[0m`);
        console.log(`\x1b[31m  Total LCG bytes consumed so far: ${lcgBytesSent}\x1b[0m`);
    }
}

// Send Ping (Opcode 1) - Sent every 1 second
// Matches: t5(R.On, g6 ? 1 : 0)  →  2-byte packet [1, 0]
function sendPing() {
    // R.On = 1, g6 is false for us (no tab visibility flag)
    const packet = new Uint8Array([OPCODE_SEND.PING, 0]);
    sendEncrypted(packet);
}

// Send Spawn / Play Request (Opcode 2)
// Matches: kY(R.Bn, playerName) in zorr-deobfuscated.js line 30789-30797
// Packet: [Opcode=2, ...nameBytes(UTF-8)]
function sendSpawn(name) {
    const nameBytes = Buffer.from(name || '', 'utf-8');
    const packet = new Uint8Array(1 + nameBytes.length);
    packet[0] = OPCODE_SEND.SPAWN_PLAY;
    packet.set(nameBytes, 1);
    sendEncrypted(packet);
    console.log(`\x1b[36m[Bot] Sent spawn/play request with name: "${name || '(empty)'}"\x1b[0m`);
}

// Send Die / Respawn (Opcode 3)
// Matches: t5(R.Un) in zorr-deobfuscated.js
function sendDie() {
    const packet = new Uint8Array([OPCODE_SEND.DIE_QUIT]);
    sendEncrypted(packet);
    console.log(`\x1b[36m[Bot] Sent die/respawn request\x1b[0m`);
}

// Send Daily Streak Claim (Opcode 16)
// Matches ta(R.na) in zorr-deobfuscated.js line 45115
function sendClaimStreak() {
    sendEncrypted(new Uint8Array([OPCODE_SEND.CLAIM_STREAK]));
    console.log(`\x1b[33m[Bot] Sent daily streak claim (opcode 16)\x1b[0m`);
    // Update local state immediately
    streakData.lastClaimTime = Date.now();
    streakData.count += 1;
    streakData.nextClaimDeadline = Date.now() + 86400000;
    // Broadcast updated state
    broadcastMapData({
        type: 'daily-streak',
        session: _currentSessionId,
        streakCount: streakData.count,
        lastClaimTime: streakData.lastClaimTime,
        nextClaimDeadline: streakData.nextClaimDeadline,
        canClaim: false
    });
}

// Send Movement / Aim direction (Opcode 5)
// Matches nD() in zorr-deobfuscated.js line 34410-34417
// t6(5, (t, n) => {
//   t.setUint8(n++, R.Gn);           // Opcode 5
//   t.setUint8(n++, nC(nz*0.5+0.5)); // X: [-1,1] → [0,1] → [0,255]
//   t.setUint8(n++, nC(nA*0.5+0.5)); // Y: [-1,1] → [0,1] → [0,255]
//   t.setUint8(n++, (k0?1:0)|(k1?2:0)); // attack/defend flags
//   t.setUint8(n++, nC(s8));            // aim direction
// })
function sendMovement(vx, vy, flags = 0) {
    // Corrupt variant inversion: invert movement when Corrupt mob is visible
    if (_corruptInvert) { vx = -vx; vy = -vy; }

    // Map float vector [-1, 1] to byte [0, 255] using game's formula: nC(v * 0.5 + 0.5)
    // nC(t) = Math.clamp(Math.floor(t * 255), 0, 255)
    const xByte = Math.max(0, Math.min(255, Math.floor((vx * 0.5 + 0.5) * 255)));
    const yByte = Math.max(0, Math.min(255, Math.floor((vy * 0.5 + 0.5) * 255)));

    // Combine caller-supplied flags with server-side persistent toggles
    // bit 0 = attack (k0 = Mouse0 | Space)
    // bit 1 = defend (k1 = Mouse2 | ShiftLeft | ShiftRight)
    const actionFlags = flags
        | (serverAttackToggled ? 1 : 0)
        | (serverDefendToggled ? 2 : 0);

    // 5 bytes: [Opcode=5, X, Y, action_flags, aim_direction]
    const packet = new Uint8Array([OPCODE_SEND.MOVEMENT, xByte, yByte, actionFlags, 127]);
    sendEncrypted(packet);
}

// 6. Handle Server Messages (Unencrypted from server)
// Opcode mapping (from R enum, first M({}) block):
//   R.Pe=0 (protocol?), R.Ie=1 (login success), R.Fe=2, R.update=3 (entity updates),
//   R.stats=11, etc.
let loggedIn = false;
let spawnSent = false;
let receivedOpcodes = new Set();

function handleMessage(bytes) {
    if (bytes.length === 0) return;

    const opcode = bytes[0];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Log new opcodes we haven't seen before
    if (!receivedOpcodes.has(opcode)) {
        receivedOpcodes.add(opcode);
        const ascii = getPrintableAscii(bytes.slice(1));
        console.log(`\x1b[90m[Recv] New Opcode: 0x${opcode.toString(16).padStart(2, '0').toUpperCase()} (${opcode}) | Size: ${bytes.length} bytes${ascii ? ` [ASCII: "${ascii}"]` : ''}\x1b[0m`);
    }

    // PostEquip: log only opcode 109 (equip ack) responses, skip noisy op3 packets
    if (equipSentTime && (Date.now() - equipSentTime < 3000) && opcode === 109) {
        console.log(`\x1b[35m[PostEquip] Equip ack received (opcode 109)\x1b[0m`);
        equipSentTime = null; // Stop tracking
    }

    // ━━━━━━ Opcode 0: Kick/Disconnect (R.Pe) ━━━━━━
    if (opcode === 0) {
        const reasonCode = bytes[1];
        const reasons = ["invalidProtocol", "outdatedVersion", "tooManyConnections", "afk", "loginFailed", "banned", "adminAction", "restricted"];
        const reasonText = reasons[reasonCode] || `unknown (${reasonCode})`;
        console.log(`\x1b[1m\x1b[31m[Recv] ★ SERVER KICKED BOT! Reason: ${reasonText} (Code: ${reasonCode})\x1b[0m`);
    }

    // ━━━━━━ Opcode 1: Login Success (R.Ie) ━━━━━━
    // This is the LOGIN confirmation packet, NOT map load.
    // Contains Entity ID, flags, inventory, loadout etc.
    // Source: zorr-deobfuscated.js line 42175-42260
    //   re = true; rm = y.$50(v); v += 4; ...
    if (opcode === 1) {
        loggedIn = true;

        // Extract Entity ID from bytes 1-4 (uint32 big-endian)
        if (bytes.length >= 5) {
            botId = view.getUint32(1);
            console.log(`\x1b[32m[Login] Connected! Bot Entity ID: ${botId} (0x${botId.toString(16).toUpperCase()}) | Packet size: ${bytes.length} bytes\x1b[0m`);
        }

        // Parse equipped petals from login packet
        try {
            let v = 1;
            const rmId = view.getUint32(v); v += 4;
            const tFlags = view.getUint8(v++);
            const ez = view.getUint16(v); v += 2;
            serverMapSize = view.getUint32(v); v += 4;
            const kM = view.getUint16(v); v += 2;

            // Skip 8 bytes high score
            v += 8;

            const score = view.getUint32(v); v += 4;
            console.log(`[Login] Checkpoint A: v=${v} packetLen=${bytes.length}`);

            // Username (1-byte length prefix)
            const usernameLen = view.getUint8(v++);
            v += usernameLen;
            console.log(`[Login] Checkpoint B: v=${v} usernameLen=${usernameLen}`);

            // Description (2-byte length prefix)
            const descLen = view.getUint16(v); v += 2;
            v += descLen;
            console.log(`[Login] Checkpoint C: v=${v} descLen=${descLen}`);

            // Lobby flag
            const lobbyFlag = view.getUint8(v++);
            console.log(`[Login] Checkpoint D: v=${v} lobbyFlag=${lobbyFlag}`);

            // Map Name (1-byte length prefix)
            const mapNameLen = view.getUint8(v++);
            mapName = Buffer.from(bytes.buffer, bytes.byteOffset + v, mapNameLen).toString('utf8');
            v += mapNameLen;
            console.log(`[Login] Checkpoint E: v=${v} mapName="${mapName}"`);

            // Biome Name (1-byte length prefix)
            const biomeNameLen = view.getUint8(v++);
            biomeName = Buffer.from(bytes.buffer, bytes.byteOffset + v, biomeNameLen).toString('utf8');
            v += biomeNameLen;
            console.log(`[Login] Checkpoint F: v=${v} biomeName="${biomeName}"`);

            // dm() grid bytes
            gridWidth = view.getUint32(v); v += 4;
            console.log(`[Login] Grid width: ${gridWidth}`);
            const gridArea = gridWidth * gridWidth;
            const gridBytes = Math.ceil(gridArea / 8);

            // Parse grid bitmap into 2D array (LSB first, matching game's dm())
            mapGrid = [];
            for (let row = 0; row < gridWidth; row++) {
                mapGrid[row] = [];
                for (let col = 0; col < gridWidth; col++) {
                    const bitIdx = row * gridWidth + col;
                    const byteIdx = Math.floor(bitIdx / 8);
                    const bitPos = bitIdx % 8;
                    const byte = bytes[v + byteIdx];
                    mapGrid[row][col] = (byte >> bitPos) & 1;
                }
            }
            v += gridBytes;

            // Pre-compute wall-distance map for center-favoring A*
            _distanceMap = buildDistanceMap(mapGrid, gridWidth, gridWidth);
            console.log(`[Login] Distance map built: ${gridWidth}x${gridWidth}`);

            // slotsCount
            const slotsCount = view.getUint8(v++);

            botEquippedPetals = [];
            for (let t = 0; t < slotsCount * 2; t++) {
                const val = view.getUint16(v) - 1; v += 2;
                if (val !== -1) {
                    const [petalIndex, rarityIndex] = decodeItemValue(val);
                    const petalName = petalNames[petalIndex] || `UnknownPetal_${petalIndex}`;
                    const rarityName = rarities[rarityIndex] ? rarities[rarityIndex].name : `Rarity_${rarityIndex}`;
                    botEquippedPetals.push({ petalName, rarityName });
                }
            }
            console.log(`\x1b[36m[Login] Parsed ${botEquippedPetals.length} Equipped Petals from server loadout.\x1b[0m`);

            // Parse inventory (ms) — server sends petalKey(uint16) + count(uint32) pairs
            // Source: zorr-deobfuscated.js line 42234-42242
            const inventoryCount = view.getUint16(v); v += 2;
            const inventory = {};
            for (let t = 0; t < inventoryCount; t++) {
                const petalKey = view.getUint16(v); v += 2;
                const count = view.getUint32(v); v += 4;
                inventory[petalKey] = count;
            }
            const inventoryEntries = Object.entries(inventory);
            console.log(`\x1b[36m[Login] Inventory: ${inventoryEntries.length} unique petals\x1b[0m`);
            // Show top 10 inventory items
            for (const [key, count] of inventoryEntries.slice(0, 10)) {
                const [pid, rid] = decodeItemValue(parseInt(key));
                const name = petalNames[pid] || `Petal_${pid}`;
                const rarity = rarities[rid]?.name || `R${rid}`;
                console.log(`\x1b[90m  ${rarity} ${name} x${count}\x1b[0m`);
            }
            console.log(`\x1b[36m[Login] Map: ${mapName} | Biome: ${biomeName} | Grid: ${gridWidth}x${gridWidth}\x1b[0m`);

            // Skip skins (uint8 count + uint8[] indices)
            const _skinsCount = view.getUint8(v++);
            v += _skinsCount;
            // Skip mob skins (uint8 count + uint8[] indices)
            const _mobSkinsCount = view.getUint8(v++);
            v += _mobSkinsCount;
            // Skip talents (uint8 count + uint8[] indices)
            const _talentsCount = view.getUint8(v++);
            v += _talentsCount;

            // Parse daily streak data
            // Source: zorr-deobfuscated.js line 42284-42290 (old-source-3)
            //   const c = y.$52(v);  v += 2;    // streakCount (uint16)
            //   const h = y.$50(v) * 1000; v += 4;  // lastClaimTime (uint32 seconds → ms)
            //   const g = y.$50(v) * 1000; v += 4;  // nextClaimDeadline (uint32 seconds → ms)
            if (v + 10 <= bytes.length) {
                streakData.count = view.getUint16(v); v += 2;
                streakData.lastClaimTime = view.getUint32(v) * 1000; v += 4;
                streakData.nextClaimDeadline = view.getUint32(v) * 1000; v += 4;
                const canClaim = streakData.lastClaimTime === 0 || Date.now() > streakData.nextClaimDeadline;
                console.log(`\x1b[33m[Login] Streak: #${streakData.count} | Last: ${streakData.lastClaimTime ? new Date(streakData.lastClaimTime).toISOString() : 'never'} | Next: ${streakData.nextClaimDeadline ? new Date(streakData.nextClaimDeadline).toISOString() : '-'} | Can Claim: ${canClaim}\x1b[0m`);
            } else {
                console.log(`\x1b[90m[Login] Streak data not available (packet too short: v=${v} len=${bytes.length})\x1b[0m`);
            }

            // Broadcast map data to web viewer
            const _urlMatch = serverUrl.match(/s-([a-z]+)-([a-z]+)\./);
            const _region = _urlMatch ? _urlMatch[1] : '';
            const _urlBiome = _urlMatch ? _urlMatch[2] : '';
            broadcastMapData({
                type: 'map',
                session: _currentSessionId,
                mapName,
                biomeName,
                region: _region,
                serverBiome: _urlBiome,
                gridWidth,
                grid: mapGrid,
                mapSize: serverMapSize
            });
            // Recompute path if navigating (grid just loaded)
            recomputePathIfNavigating();
            console.log(`[Login] Map data broadcasted: ${mapName}/${biomeName} grid=${gridWidth}x${gridWidth}`);
            // Broadcast streak data to web viewer
            broadcastMapData({
                type: 'daily-streak',
                session: _currentSessionId,
                streakCount: streakData.count,
                lastClaimTime: streakData.lastClaimTime,
                nextClaimDeadline: streakData.nextClaimDeadline,
                canClaim: streakData.lastClaimTime === 0 || Date.now() > streakData.nextClaimDeadline
            });
            // Auto patrol: check if a route exists for this server
            apOnLogin();
        } catch (err) {
            console.error('[Login] Failed to parse login packet:', err.message);
            console.error('[Login] Packet hex:', Array.from(bytes.slice(0, Math.min(bytes.length, 80))).map(b => b.toString(16).padStart(2, '0')).join(' '));
        }

        // Start ping loop immediately
        if (!pingInterval) {
            pingInterval = setInterval(() => { sendPing(); }, 1000);
            console.log('[Bot] Ping loop started (1s interval).');
        }

        // Send spawn/play request after a short delay
        if (!spawnSent) {
            setTimeout(() => {
                // Send all settings that the game client sends in s2() after login
                // Opcode 117 (R.Yo) = vision scale (gx=30)
                sendEncrypted(new Uint8Array([117, 30]));
                // Opcode 104 (R.Lo) = guildSquad (true)
                sendEncrypted(new Uint8Array([104, 1]));
                // Opcode 105 (R.Ho) = showPositionToGuild (true)
                sendEncrypted(new Uint8Array([105, 1]));
                // Opcode 118 (R.Xo) = showOtherPetals (false)
                sendEncrypted(new Uint8Array([118, 0]));
                // Opcode 119 (R.Zo) = showOtherPets (false)
                sendEncrypted(new Uint8Array([119, 0]));
                console.log('\x1b[36m[Bot] Sent all settings to server (visionScale, guildSquad, showPosition, showPetals, showPets)\x1b[0m');

                sendSpawn(botName);
                spawnSent = true;
            }, 500);
        }
    }

    // ━━━━━━ Opcode 3: Entity Updates (R.update) ━━━━━━
    if (opcode === 3) {
        parseEntityUpdates(bytes);

        // Respawn flow: entity update after spawn_sent means we're back
        if (respawnState === 'spawn_sent' && !isSpawned) {
            isSpawned = true;
            isDead = false;
            respawnState = '';
            console.log(`\x1b[32m[Bot] ★ Respawn complete! Back in game.\x1b[0m`);
            apOnSpawned();
        }

        // Initial spawn detection (only when not in respawn flow and not in title mode)
        if (spawnSent && !isSpawned && !respawnState && !returnToTitle) {
            isSpawned = true;
            onSpawned();
        }
    }

    // ━━━━━━ Opcode 11: Inventory/Stats Update (0x0B) ━━━━━━
    // Parses real inventory packets (count > 0, expectedSize matches).
    // Non-inventory 21-byte packets with count=0 are silently dropped
    // (they appear to be periodic score/stats events with an unknown
    // format; no action needed and no longer logged).
    if (opcode === 11) {
        try {
            let iv = 1; // skip opcode
            const invCount = view.getUint16(iv); iv += 2;
            const expectedSize = 3 + invCount * 6; // opcode + uint16 + (uint16+uint32)*N

            if (invCount > 0 && expectedSize <= bytes.length) {
                // Looks like a real inventory packet
                const newInventory = {};
                for (let t = 0; t < invCount && iv + 6 <= bytes.length; t++) {
                    const petalKey = view.getUint16(iv); iv += 2;
                    const count = view.getUint32(iv); iv += 4;
                    newInventory[petalKey] = count;
                }
                botInventory = newInventory;
                const totalItems = Object.values(botInventory).reduce((a, b) => a + b, 0);
                console.log(`\x1b[36m[Inventory] Updated: ${Object.keys(botInventory).length} unique petals, ${totalItems} total items\x1b[0m`);
            }
            // else: silent (non-inventory 21B packet, format unknown)
        } catch (err) {
            // Silent: defensive only
        }
    }

    // ━━━━━━ Opcode 4: Death Notification (R.De) ━━━━━━
    // Server sends this when the player dies. The server always expects
    // a death ack (opcode 3) after opcode 4, even if we already sent
    // die earlier (e.g. via title command). Without this ack, the server
    // never sends opcode 5 (cleanup) and the player entity stays in-game.
    if (opcode === 4) {
        if (!isDead) {
            isDead = true;
            isSpawned = false;
            navPath = [];
            navigateTarget = null;
            _resetStuck();
        }
        apOnDeath();
        console.log(`\x1b[31m[Bot] ★ Death notification (op4), sending die ack...\x1b[0m`);
        sendDie();
        respawnState = 'die_sent';
    }

    // ━━━━━━ Opcode 5: Entity Cleanup (R.Re) ── Ready to respawn ━━━━━━
    // Server sends this after receiving our death ack (opcode 3).
    if (opcode === 5 && respawnState === 'die_sent') {
        if (returnToTitle) {
            // Stay on title screen — do not auto-respawn
            console.log(`\x1b[35m[Bot] Cleanup received. Title mode: staying on title screen.\x1b[0m`);
            respawnState = '';
            isDead = false; // Allow future title/death commands
            broadcastMapData({ type: 'despawn', session: _currentSessionId });
        } else {
            console.log(`\x1b[36m[Bot] Cleanup received! Sending spawn request...\x1b[0m`);
            sendSpawn(botName);
            respawnState = 'spawn_sent';
        }
    }

    // ━━━━━━ Opcode 6: Revive (R.Ee) ━━━━━━
    if (opcode === 6) {
        console.log(`\x1b[32m[Bot] Revived by another player!\x1b[0m`);
        isDead = false;
        isSpawned = true;
        returnToTitle = false;
        respawnState = '';
    }
}

// Helper to extract readable ASCII string segments from binary payload
function getPrintableAscii(bytes) {
    let result = [];
    let currentStr = '';
    for (const b of bytes) {
        if (b >= 32 && b <= 126) {
            currentStr += String.fromCharCode(b);
        } else {
            if (currentStr.length >= 3) result.push(currentStr);
            currentStr = '';
        }
    }
    if (currentStr.length >= 3) result.push(currentStr);
    return result.join(' | ');
}

// Navigation state
let navigateTarget = null;
let navPath = [];
let navWaypointIndex = 0;
let navRoute = [];        // Route waypoints for patrol [{x, y}, ...]
let navRouteIndex = 0;    // Current index in navRoute

// Stuck detection / wall-avoidance backing
let _stuckCellKey = null;
let _stuckSince = 0;
let _franticMode = false;
let _franticOriginCX = 0;
let _franticOriginCY = 0;
let _franticDirIndex = 0;
let _franticDirEnd = 0;
const _FRANTIC_DIRS = [
    [1, 0], [1, -1], [0, -1], [-1, -1],
    [-1, 0], [-1, 1], [0, 1], [1, 1]
];
let _corruptInvert = false;
// Mob-blocking detour state
let _mobBlockDefending = false;  // true while defending (pushing) through a blocked cell
let _mobBlockDetouring = false;  // true while following a detour around a mob
let _mobBlockDefendUntil = 0;    // timestamp: defend until this time
let _mobBlockWPKey = '';         // routeWP key to prevent retry spam
function _resetStuck() {
    _stuckCellKey = null;
    _franticMode = false;
    _mobBlockDefending = false;
    _mobBlockDetouring = false;
    _mobBlockWPKey = '';
    _mobBlockDefendUntil = 0;
}

// ━━━━━━ Auto Patrol State Machine ━━━━━━
const _AP = {
    active: false,
    state: 'idle', // idle|pinky_build|wait_pinky|move_build|patrolling|next_server|route_check
    pinkyFailCount: 0,
    moveDeathCount: 0,
    pinkyTimeout: null,
    servers: [],       // [{region, biome}, ...]
    serverIndex: 0,
    buildSwitchTimeout: null,
    log: [],
    routes: {},        // Route data fetched from map_server
};
const AP_LOG_MAX = 50;
function apLog(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    _AP.log.push(line);
    if (_AP.log.length > AP_LOG_MAX) _AP.log.shift();
    console.log(`\x1b[36m[AutoPatrol] ${msg}\x1b[0m`);
    broadcastMapData({ type: 'auto-patrol', session: _currentSessionId, state: _AP.state, pinkyFailCount: _AP.pinkyFailCount, moveDeathCount: _AP.moveDeathCount, active: _AP.active, currentServer: _AP.servers[_AP.serverIndex] || null, serverIndex: _AP.serverIndex, serverCount: _AP.servers.length, log: _AP.log.slice(-10) });
}
function apClearTimers() {
    if (_AP.pinkyTimeout) { clearTimeout(_AP.pinkyTimeout); _AP.pinkyTimeout = null; }
    if (_AP.buildSwitchTimeout) { clearTimeout(_AP.buildSwitchTimeout); _AP.buildSwitchTimeout = null; }
}
function _fetchRoutes() {
    return new Promise((resolve, reject) => {
        http.get('http://localhost:3000/routes', (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { _AP.routes = JSON.parse(body) || {}; resolve(); }
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}
function apStop() {
    apClearTimers();
    _AP.active = false;
    _AP.state = 'idle';
    _AP.pinkyFailCount = 0;
    _AP.moveDeathCount = 0;
    _AP.servers = [];
    _AP.serverIndex = 0;
    _AP.log = [];
    navRoute = [];
    navRouteIndex = 0;
    navPath = [];
    navigateTarget = null;
    sendMovement(0, 0);
    apLog('Auto Patrol STOPPED');
}
function apStart(servers) {
    if (_AP.active) { apStop(); }
    _AP.active = true;
    _AP.servers = servers || [];
    _AP.pinkyFailCount = 0;
    _AP.moveDeathCount = 0;
    // Start from the current biome if it exists in the server list
    const _uMatch = serverUrl.match(/s-([a-z]+)-([a-z]+)\./);
    if (_uMatch) {
        const curRegion = _uMatch[1];
        const curBiome = _uMatch[2];
        const idx = _AP.servers.findIndex(s => s.region === curRegion && s.biome === curBiome);
        _AP.serverIndex = idx >= 0 ? idx : 0;
    } else {
        _AP.serverIndex = 0;
    }
    apLog(`Auto Patrol STARTED: ${_AP.servers.length} servers queued, starting at index ${_AP.serverIndex}`);
    // Fetch route data from map_server, then start patrolling
    _fetchRoutes().then(() => apAdvance()).catch(() => {
        apLog('Failed to fetch routes, starting anyway');
        apAdvance();
    });
}
function apAdvance() {
    if (!_AP.active) return;
    if (_AP.serverIndex >= _AP.servers.length) {
        apLog('All servers completed, looping back to start');
        _AP.serverIndex = 0;
    }
    const srv = _AP.servers[_AP.serverIndex];
    if (!srv) { apStop(); return; }
    apLog(`→ Server ${srv.region}-${srv.biome} (${_AP.serverIndex + 1}/${_AP.servers.length})`);
    _AP.state = 'next_server';
    switchBotServer(srv.region, srv.biome);
    // After switch completes, login will fire → apOnLogin()
}
function apOnLogin() {
    if (!_AP.active || _AP.state !== 'next_server') return;
    // Construct route key from the in-game biome/map names
    const routeKey = `${biomeName}-${mapName}`;
    const waypoints = _AP.routes[routeKey];
    if (!waypoints || waypoints.length === 0) {
        apLog(`Skip: ${routeKey} (no route)`);
        _AP.serverIndex++;
        return;
    }
    apLog(`Route found: ${routeKey} (${waypoints.length} waypoints)`);
    // Store waypoints on the current server entry for apOnSpawned to use
    _AP.servers[_AP.serverIndex].waypoints = waypoints;
    _AP.servers[_AP.serverIndex].routeKey = routeKey;
}
function apOnSpawned() {
    if (!_AP.active) return;
    if (_AP.state === 'next_server') {
        // Check if current server has a route before proceeding
        const routeKey = `${biomeName}-${mapName}`;
        const waypoints = _AP.routes[routeKey];
        if (!waypoints || waypoints.length === 0) {
            apLog(`No route for ${routeKey}, skipping`);
            _AP.serverIndex++;
            apAdvance();
            return;
        }
        _AP.servers[_AP.serverIndex].waypoints = waypoints;
        _AP.servers[_AP.serverIndex].routeKey = routeKey;
        _AP.state = 'pinky_build';
        apLog('Spawned, equipping pinky build');
        _equipBuild('loadouts/pinky.txt');
        // Start 60s timeout for pinky acquisition
        apClearTimers();
        _AP.pinkyTimeout = setTimeout(() => {
            if (!_AP.active || _AP.state !== 'wait_pinky') return;
            apLog('60s pinky timeout!');
            _AP.pinkyFailCount++;
            if (_AP.pinkyFailCount >= 3) {
                apLog(`${_AP.pinkyFailCount} consecutive pinky failures → next server`);
                _AP.serverIndex++;
                apAdvance();
            } else {
                apLog(`Pinky fail ${_AP.pinkyFailCount}/3, death+respawn retry`);
                _triggerDeath();
            }
        }, 60000);
    } else if (_AP.state === 'pinky_build') {
        // Spawned after pinky equip, now waiting for pinky state.
        // If already pinky (carried over from previous server), skip ahead.
        if (isPinky) {
            apLog('Already pinky, skipping to move build');
            _AP.state = 'move_build';
            _equipBuild('loadouts/move.txt');
        } else {
            _AP.state = 'wait_pinky';
            apLog('Waiting for pinky state...');
        }
    } else if (_AP.state === 'move_build') {
        // Spawned after move equip, start patrolling
        _AP.state = 'patrolling';
        _AP.pinkyFailCount = 0;
        _AP.moveDeathCount = 0;
        apLog(`Pinky fail counter reset. Patrolling route...`);
        const srv = _AP.servers[_AP.serverIndex];
        if (srv && srv.waypoints && srv.waypoints.length > 0) {
            navRoute = srv.waypoints;
            navRouteIndex = 0;
            navigateTarget = { x: srv.waypoints[0].x, y: srv.waypoints[0].y };
            computePath();
        } else {
            apLog('No route, moving to next server');
            _AP.serverIndex++;
            apAdvance();
        }
    }
}
function apOnPinkyState(nowPinky) {
    if (!_AP.active || !nowPinky) return;
    if (_AP.state === 'wait_pinky' || _AP.state === 'pinky_build') {
        apClearTimers();
        apLog('Pinky ACQUIRED! Switching to move build');
        _AP.state = 'move_build';
        _equipBuild('loadouts/move.txt');
        // Start patrolling immediately without respawn
        _AP.state = 'patrolling';
        _AP.pinkyFailCount = 0;
        _AP.moveDeathCount = 0;
        apLog('Patrolling route...');
        const srv = _AP.servers[_AP.serverIndex];
        if (srv && srv.waypoints && srv.waypoints.length > 0) {
            navRoute = srv.waypoints;
            navRouteIndex = 0;
            navigateTarget = { x: srv.waypoints[0].x, y: srv.waypoints[0].y };
            computePath();
        } else {
            apLog('No route, moving to next server');
            _AP.serverIndex++;
            apAdvance();
        }
    }
}
function apOnDeath() {
    if (!_AP.active) return;
    if (_AP.state === 'wait_pinky') {
        apClearTimers();
        _AP.pinkyFailCount++;
        apLog(`Death during pinky wait (${_AP.pinkyFailCount}/3)`);
        if (_AP.pinkyFailCount >= 3) {
            apLog('3 consecutive pinky failures → next server');
            _AP.serverIndex++;
            apAdvance();
        }
        // else: respawn will trigger apOnSpawned → pinky_build retry
    } else if (_AP.state === 'patrolling') {
        _AP.moveDeathCount++;
        apLog(`Death during patrol (${_AP.moveDeathCount}/5)`);
        if (_AP.moveDeathCount >= 5) {
            apLog('5 move deaths → next server');
            navRoute = [];
            navRouteIndex = 0;
            _AP.serverIndex++;
            apAdvance();
        } else {
            _AP.state = 'next_server';
            // else: respawn will trigger apOnSpawned → pinky_build
        }
    } else if (_AP.state === 'pinky_build' || _AP.state === 'move_build') {
        apLog('Death during build switch, will retry on respawn');
    }
}
function apOnRouteComplete() {
    if (!_AP.active || _AP.state !== 'patrolling') return;
    apLog('Route complete! Moving to next server');
    _AP.serverIndex++;
    apAdvance();
}
function _equipBuild(file) {
    const cmd = { action: 'equip', buildFile: file, buildCode: null, talents: null };
    _pendingEquipCmd = cmd;
    _processPendingEquip();
}
function _triggerDeath() {
    if (!isDead && !respawnState) {
        isDead = true;
        isSpawned = false;
        navPath = [];
        navigateTarget = null;
        navRoute = [];
        navRouteIndex = 0;
        respawnState = 'die_sent';
        sendDie();
    }
}

// Server-controlled persistent action toggles (bit 0 = attack, bit 1 = defend)
let serverAttackToggled = false;
let serverDefendToggled = false;

function pollCommand() {
    Promise.all([
        fetch(new URL('/command', MAP_SERVER_URL)).catch(() => null),
        fetch(new URL('/state', MAP_SERVER_URL)).catch(() => null),
    ])
        .then(([cmdRes, stateRes]) => {
            // Update persistent toggle state first (used by all subsequent movement packets)
            if (stateRes) {
                return stateRes.json().then(s => {
                    if (s.attack !== serverAttackToggled || s.defend !== serverDefendToggled) {
                        console.log(`\x1b[33m[Action] Server state changed: attack=${s.attack} defend=${s.defend}\x1b[0m`);
                        serverAttackToggled = !!s.attack;
                        serverDefendToggled = !!s.defend;
                    }
                    return cmdRes ? cmdRes.json() : null;
                });
            }
            return cmdRes ? cmdRes.json() : null;
        })
        .then(cmd => {
            if (!cmd) return;
            if (cmd.action === 'navigate') {
                navigateTarget = { x: cmd.x, y: cmd.y };
                console.log(`\x1b[36m[Nav] New target: (${cmd.x}, ${cmd.y})\x1b[0m`);
                fetch(new URL('/ack', MAP_SERVER_URL), { method: 'POST' }).catch(() => { });
                computePath();
            } else if (cmd.action === 'death') {
                console.log(`\x1b[33m[Bot] Death command received from map viewer!\x1b[0m`);
                fetch(new URL('/ack', MAP_SERVER_URL), { method: 'POST' }).catch(() => { });
                if (!isDead && !respawnState) {
                    isDead = true;
                    isSpawned = false;
                    navPath = [];
                    navigateTarget = null;
                    respawnState = 'die_sent';
                    sendDie();
                }
            } else if (cmd.action === 'title') {
                // Return to title screen: send die, then stay on title (no auto-respawn)
                console.log(`\x1b[35m[Bot] Title command received from map viewer!\x1b[0m`);
                fetch(new URL('/ack', MAP_SERVER_URL), { method: 'POST' }).catch(() => { });
                if (!isDead && !respawnState && !returnToTitle) {
                    isDead = true;
                    isSpawned = false;
                    navPath = [];
                    navigateTarget = null;
                    returnToTitle = true;
                    respawnState = 'die_sent';
                    sendDie();
                }
        } else if (cmd.action === 'spawn') {
            // Re-enter game from title screen
            console.log(`\x1b[32m[Bot] Spawn command received from map viewer!\x1b[0m`);
            fetch(new URL('/ack', MAP_SERVER_URL), { method: 'POST' }).catch(() => { });
            returnToTitle = false;
            if (!isSpawned && respawnState !== 'spawn_sent') {
                sendSpawn(botName);
                respawnState = 'spawn_sent';
            }
            } else if (cmd.action === 'equip') {
                // Fallback path (SSE push is primary). Coalesce with pending
                if (!_pendingEquipCmd) _pendingEquipCmd = cmd;
                fetch(new URL('/ack', MAP_SERVER_URL), { method: 'POST' }).catch(() => { });
            } else if (cmd.type === 'switch') {
                console.log(`\x1b[35m[Switch] Server switch requested: ${cmd.region}/${cmd.biome}\x1b[0m`);
                fetch(new URL('/ack', MAP_SERVER_URL), { method: 'POST' }).catch(() => { });
                // Close current WS and reconnect to the new server URL
                switchBotServer(cmd.region, cmd.biome);
            } else if (cmd.action === 'patrol') {
                const route = cmd.route || [];
                if (route.length > 0) {
                    console.log(`\x1b[36m[Patrol] Route received: ${route.length} waypoints\x1b[0m`);
                    navRoute = route;
                    navRouteIndex = 0;
                    navigateTarget = { x: route[0].x, y: route[0].y };
                    computePath();
                }
                fetch(new URL('/ack', MAP_SERVER_URL), { method: 'POST' }).catch(() => { });
            }
        })
        .catch(() => { });
}

// === Center-favoring A* pathfinding ===
const CENTER_COST = 25;
let _distanceMap = null;

function buildDistanceMap(grid, rows, cols) {
    const dist = Array.from({ length: rows }, () => Array(cols).fill(Infinity));
    const queue = [];
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            if (grid[y][x] === 0) { dist[y][x] = 0; queue.push([x, y]); }
        }
    }
    let head = 0;
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    while (head < queue.length) {
        const [x, y] = queue[head++];
        for (const [dx, dy] of dirs) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            if (dist[ny][nx] > dist[y][x] + 1) {
                dist[ny][nx] = dist[y][x] + 1;
                queue.push([nx, ny]);
            }
        }
    }
    return dist;
}

// A* pathfinding on grid (game convention: 0=wall, 1=walkable)
const _navWarned = { noGrid: false, oob: false, allWalls: false, noPath: false };
function computePath() {
    if (!mapGrid || !navigateTarget) { if (!_navWarned.noGrid) { console.log('[Nav] computePath: no grid or target'); _navWarned.noGrid = true; } return; }
    const cSize = serverMapSize / gridWidth;
    const sx = Math.floor(botX / cSize);
    const sy = Math.floor(botY / cSize);
    let ex = Math.floor(navigateTarget.x / cSize);
    let ey = Math.floor(navigateTarget.y / cSize);
    const rows = mapGrid.length;
    const cols = mapGrid[0].length;

    if (sx < 0 || sx >= cols || sy < 0 || sy >= rows) { if (!_navWarned.oob) { console.log('[Nav] bot out of grid bounds'); _navWarned.oob = true; } navPath = []; return; }
    _navWarned.oob = false;  // reset on valid call
    ex = Math.max(0, Math.min(cols - 1, ex));
    ey = Math.max(0, Math.min(rows - 1, ey));

    // Snap target to nearest walkable cell (1) if it's a wall (0)
    if (mapGrid[ey][ex] === 0) {
        let found = false;
        let bestDist = Infinity;
        let bx = ex, by = ey;
        for (let r = -2; r <= 2; r++) {
            for (let c = -2; c <= 2; c++) {
                const ny = ey + r, nx = ex + c;
                if (ny >= 0 && ny < rows && nx >= 0 && nx < cols && mapGrid[ny][nx] === 1) {
                    const d = Math.hypot(nx - ex, ny - ey);
                    if (d < bestDist) { bestDist = d; bx = nx; by = ny; found = true; }
                }
            }
        }
        if (found) { ex = bx; ey = by; }
        else { if (!_navWarned.allWalls) { console.log('[Nav] Target area all walls'); _navWarned.allWalls = true; } navPath = []; return; }
        _navWarned.allWalls = false;
    }

    const key = (x, y) => x + ',' + y;
    const startKey = key(sx, sy);
    const endKey = key(ex, ey);
    if (startKey === endKey) { navPath = []; return; }

    const open = new MinHeap();
    open.push({ x: sx, y: sy, f: 0, g: 0 });
    const openSet = new Set([startKey]);
    const closedSet = new Set();
    const cameFrom = {};
    const gScore = { [startKey]: 0 };

    let found = false;
    let iterations = 0;

    while (open.size > 0 && iterations++ < 50000) {
        const cur = open.pop();
        const curKey = key(cur.x, cur.y);

        // Lazy deletion: skip if already processed with a better score
        if (closedSet.has(curKey)) continue;
        closedSet.add(curKey);

        if (curKey === endKey) { found = true; break; }

        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = cur.x + dx;
                const ny = cur.y + dy;
                if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
                if (mapGrid[ny][nx] === 0) continue; // 0=wall
                if (dx !== 0 && dy !== 0) {
                    if (mapGrid[cur.y][nx] === 0 || mapGrid[ny][cur.x] === 0) continue;
                }
                const nKey = key(nx, ny);
                if (closedSet.has(nKey)) continue;
                const baseCost = (dx !== 0 && dy !== 0) ? 1.414 : 1;
                const wallDist = _distanceMap ? _distanceMap[ny][nx] : 10;
                const moveCost = baseCost + CENTER_COST / (wallDist + 1);
                const g = gScore[curKey] + moveCost;
                if (g < (gScore[nKey] ?? Infinity)) {
                    cameFrom[nKey] = curKey;
                    gScore[nKey] = g;
                    const h = Math.hypot(ex - nx, ey - ny);
                    open.push({ x: nx, y: ny, f: g + h, g });
                    openSet.add(nKey);
                }
            }
        }
    }

    if (!found) { navPath = []; if (!_navWarned.noPath) { console.log('\x1b[33m[Nav] No path found\x1b[0m'); _navWarned.noPath = true; } return; }
    _navWarned.noPath = false;  // reset on success

    const path = [];
    let cur = endKey;
    while (cur) {
        const [cx, cy] = cur.split(',').map(Number);
        path.push([cx, cy]);
        cur = cameFrom[cur];
    }
    path.reverse();

    _stuckCellKey = null;
    navPath = path;
    // Find the closest waypoint in the new path to the bot's current cell
    // to avoid backtracking or skipping waypoints
    let closestIdx = 0;
    let closestDist = Infinity;
    for (let i = 0; i < path.length; i++) {
        const d = Math.abs(path[i][0] - sx) + Math.abs(path[i][1] - sy);
        if (d < closestDist) { closestDist = d; closestIdx = i; }
    }
    navWaypointIndex = closestIdx;
    lastComputeCell = sx + ',' + sy;
}

// Find the direction (vx, vy) away from the nearest wall
function _findNearestWallDir(cx, cy) {
    const dir = [
        [0, -1], [1, -1], [1, 0], [1, 1],
        [0, 1], [-1, 1], [-1, 0], [-1, -1]
    ];
    let bestDist = Infinity;
    let bestVX = 1;
    let bestVY = 0;
    for (let dr = 1; dr <= 3; dr++) {
        for (const [dx, dy] of dir) {
            const nx = cx + dx * dr;
            const ny = cy + dy * dr;
            if (nx < 0 || nx >= gridWidth || ny < 0 || ny >= gridWidth) continue;
            if (mapGrid[ny][nx] === 1) {
                if (dr < bestDist) {
                    bestDist = dr;
                    bestVX = -dx;
                    bestVY = -dy;
                }
            }
        }
    }
    if (bestDist === Infinity) {
        bestVX = 1;
        bestVY = 0;
    }
    const len = Math.sqrt(bestVX * bestVX + bestVY * bestVY) || 1;
    return { vx: bestVX / len, vy: bestVY / len };
}

// Check if a mob's hitbox completely covers a grid cell
function _isCellBlockedByMob(cellX, cellY, cSize) {
    if (!activeMobs.size) return false;
    // Cell AABB in game coordinates
    const cellMinX = cellX * cSize;
    const cellMinY = cellY * cSize;
    const cellMaxX = (cellX + 1) * cSize;
    const cellMaxY = (cellY + 1) * cSize;
    for (const mob of activeMobs.values()) {
        const r = mob.size || 0;
        if (r <= 0) continue;
        // Mob AABB (center ± radius)
        if (cellMinX >= mob.x - r && cellMaxX <= mob.x + r &&
            cellMinY >= mob.y - r && cellMaxY <= mob.y + r) {
            return true;
        }
    }
    return false;
}

// Compute wall-aware movement direction toward target
// If direct path is blocked by a wall, find the best alternative direction
function _wallAwareMove(desiredVX, desiredVY, cx, cy) {
    if (!mapGrid || !mapGrid[0]) return { vx: desiredVX, vy: desiredVY };

    // Check if direct move would enter a wall
    const checkX = cx + (desiredVX > 0.3 ? 1 : desiredVX < -0.3 ? -1 : 0);
    const checkY = cy + (desiredVY > 0.3 ? 1 : desiredVY < -0.3 ? -1 : 0);
    const rows = mapGrid.length, cols = mapGrid[0].length;

    // If no wall in direct path, use it
    if (checkX >= 0 && checkX < cols && checkY >= 0 && checkY < rows && mapGrid[checkY][checkX] === 1) {
        return { vx: desiredVX, vy: desiredVY };
    }

    // Wall detected: find best alternative direction that's walkable and closest to desired
    const dirs = [
        [1, 0], [0, 1], [-1, 0], [0, -1],
        [1, 1], [-1, 1], [1, -1], [-1, -1]
    ];
    let bestDot = -Infinity;
    let bestDir = null;

    for (const [dx, dy] of dirs) {
        // Check if this neighbor is walkable
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
        if (mapGrid[ny][nx] === 0) continue;

        // For diagonal moves, check corner-cutting
        if (dx !== 0 && dy !== 0) {
            if (mapGrid[cy][nx] === 0 || mapGrid[ny][cx] === 0) continue;
        }

        // Pick direction closest to desired
        const dlen = Math.hypot(dx, dy) || 1;
        const dot = (dx / dlen) * desiredVX + (dy / dlen) * desiredVY;
        if (dot > bestDot) {
            bestDot = dot;
            bestDir = [dx / dlen, dy / dlen];
        }
    }

    return bestDir ? { vx: bestDir[0], vy: bestDir[1] } : { vx: desiredVX, vy: desiredVY };
}

function navigateTick() {
    // Defend phase: try to push through a blocked cell before attempting detour
    if (_mobBlockDefending) {
        if (Date.now() < _mobBlockDefendUntil && navigateTarget) {
            _corruptInvert = false;
            for (const mob of activeMobs.values()) {
                if (mob.variant === 5) { _corruptInvert = true; break; }
            }
            const cSize = serverMapSize / gridWidth;
            const dx = navigateTarget.x - botX;
            const dy = navigateTarget.y - botY;
            const dist = Math.hypot(dx, dy) || 1;
            const wallDir = _wallAwareMove(dx / dist, dy / dist,
                Math.floor(botX / cSize), Math.floor(botY / cSize));
            sendMovement(wallDir.vx, wallDir.vy, 2);
            return;
        }
        // Defend time expired; check if cell is still blocked
        _mobBlockDefending = false;
        if (navigateTarget) {
            const cSize = serverMapSize / gridWidth;
            const tgtCX = Math.floor(navigateTarget.x / cSize);
            const tgtCY = Math.floor(navigateTarget.y / cSize);
            if (_isCellBlockedByMob(tgtCX, tgtCY, cSize)) {
                // Defend failed → switch to detour
                _mobBlockDetouring = true;
                const prevVal = mapGrid[tgtCY][tgtCX];
                mapGrid[tgtCY][tgtCX] = 0;
                computePath();
                mapGrid[tgtCY][tgtCX] = prevVal;
                if (navPath.length === 0) {
                    // No detour possible → skip this waypoint
                    console.log(`[MobBlock] No detour after defend, skip WP cell ${tgtCX},${tgtCY}`);
                    _mobBlockDetouring = false;
                    _mobBlockWPKey = '';
                    navRouteIndex++;
                    if (navRouteIndex >= navRoute.length) {
                        navRoute = [];
                        navRouteIndex = 0;
                        apOnRouteComplete();
                        sendMovement(0, 0);
                        return;
                    }
                    navigateTarget = { x: navRoute[navRouteIndex].x, y: navRoute[navRouteIndex].y };
                    computePath();
                    return;
                }
                console.log(`[MobBlock] Detour found after defend for cell ${tgtCX},${tgtCY}`);
            } else {
                // Cell cleared during defend → proceed normally
                _mobBlockWPKey = '';
            }
        }
    }

    if (!isSpawned || (!navPath.length && !navRoute.length) || (!navigateTarget && navRoute.length === 0)) {
        sendMovement(0, 0);
        return;
    }

    // Corrupt mob inversion: if any visible mob has variant === 5 (Corrupt), invert movement
    _corruptInvert = false;
    for (const mob of activeMobs.values()) {
        if (mob.variant === 5) { _corruptInvert = true; break; }
    }

    const cSize = serverMapSize / gridWidth;
    // Bot's current grid cell
    const botCX = Math.floor(botX / cSize);
    const botCY = Math.floor(botY / cSize);

    // --- Stuck detection / wall-avoidance backing ---
    const cellKey = botCX + ',' + botCY;
    const now = Date.now();

    // Frantic mode: multi-direction movement until grid changes by 2+
    if (_franticMode) {
        if (Math.abs(botCX - _franticOriginCX) >= 2 || Math.abs(botCY - _franticOriginCY) >= 2) {
            _franticMode = false;
            _stuckCellKey = cellKey;
            _stuckSince = now;
            console.log('[Stuck] Frantic mode ended, grid shifted 2+');
            if (navigateTarget) computePath();
        } else {
            if (now >= _franticDirEnd) {
                _franticDirIndex = (_franticDirIndex + 1) % _FRANTIC_DIRS.length;
                _franticDirEnd = now + 300 + Math.random() * 500;
            }
            const d = _FRANTIC_DIRS[_franticDirIndex];
            sendMovement(d[0], d[1], 2);
            return;
        }
    }

    if (navPath.length > 0 || navRoute.length > 0) {
        if (cellKey === _stuckCellKey) {
            if (now - _stuckSince > 3000) {
                _franticMode = true;
                _franticOriginCX = botCX;
                _franticOriginCY = botCY;
                _franticDirIndex = 0;
                _franticDirEnd = now + 300 + Math.random() * 500;
                _stuckCellKey = null;
                const d = _FRANTIC_DIRS[0];
                sendMovement(d[0], d[1], 2);
                console.log('[Stuck] Stuck detected, entering frantic mode');
                return;
            }
        } else {
            _stuckCellKey = cellKey;
            _stuckSince = now;
        }
    } else {
        _stuckCellKey = null;
        _stuckSince = now;
    }
    // --- End stuck detection ---

    // Route patrol (skipped while detouring to avoid path recomputation)
    if (navRoute.length > 0 && navRouteIndex < navRoute.length && !_mobBlockDetouring) {
        const target = navRoute[navRouteIndex];
        const targetCX = Math.floor(target.x / cSize);
        const targetCY = Math.floor(target.y / cSize);
        // 2x2 grid arrival check: bot is within 1 cell of waypoint
        if (Math.abs(botCX - targetCX) <= 1 && Math.abs(botCY - targetCY) <= 1) {
            // Reached this waypoint, move to next
            _mobBlockDefending = false;
            _mobBlockDetouring = false;
            _mobBlockWPKey = '';
            _mobBlockDefendUntil = 0;
            navRouteIndex++;
            if (navRouteIndex >= navRoute.length) {
                // Route complete
                navRoute = [];
                navRouteIndex = 0;
                console.log('\x1b[32m[Patrol] Route complete!\x1b[0m');
                apOnRouteComplete();
                fetch(new URL('/ack', MAP_SERVER_URL), { method: 'POST' }).catch(() => {});
                sendMovement(0, 0);
                return;
            }
            // Compute path to next route waypoint
            navigateTarget = { x: navRoute[navRouteIndex].x, y: navRoute[navRouteIndex].y };
            computePath();
            return;
        }
        // Move toward current route waypoint
        if (!navigateTarget || Math.abs(navigateTarget.x - target.x) > 1 || Math.abs(navigateTarget.y - target.y) > 1) {
            navigateTarget = { x: target.x, y: target.y };
            computePath();
        }
        // Fall through to normal path following below
    }

    // --- Mob-blocking detection: defend first, then detour ---
    if (navigateTarget && navRoute.length > 0 && !_mobBlockDefending && !_mobBlockDetouring) {
        const tgtCX = Math.floor(navigateTarget.x / cSize);
        const tgtCY = Math.floor(navigateTarget.y / cSize);
        const wpKey = tgtCX + ',' + tgtCY;

        if (_isCellBlockedByMob(tgtCX, tgtCY, cSize)) {
            if (_mobBlockWPKey !== wpKey) {
                // First time seeing this blocked cell: start defend phase
                _mobBlockWPKey = wpKey;
                _mobBlockDefending = true;
                _mobBlockDefendUntil = Date.now() + 1000;
                console.log(`[MobBlock] Defending for 1s at ${wpKey}`);
            }
        } else {
            // Target cell is clear: reset mob-block state
            _mobBlockWPKey = '';
        }
    }
    // --- End mob-blocking ---

    if (!navPath.length || !navigateTarget) {
        sendMovement(0, 0);
        return;
    }

    const wp = navPath[navWaypointIndex];

    // Final target: 2x2 grid arrival check
    const tgtCX = Math.floor(navigateTarget.x / cSize);
    const tgtCY = Math.floor(navigateTarget.y / cSize);
    if (Math.abs(botCX - tgtCX) <= 1 && Math.abs(botCY - tgtCY) <= 1) {
        _mobBlockDefending = false;
        _mobBlockDetouring = false;
        _mobBlockWPKey = '';
        navPath = [];
        navigateTarget = null;
        sendMovement(0, 0);
        return;
    }

    // Waypoint: 2x2 grid arrival check
    if (Math.abs(botCX - wp[0]) <= 1 && Math.abs(botCY - wp[1]) <= 1) {
        navWaypointIndex++;
        if (navWaypointIndex >= navPath.length) {
            if (_mobBlockDetouring) {
                // Detour path exhausted but not at target: skip this waypoint
                _mobBlockDetouring = false;
                _mobBlockWPKey = '';
                navPath = [];
                navigateTarget = null;
                console.log('[MobBlock] Detour exhausted, skip WP');
                navRouteIndex++;
                if (navRouteIndex >= navRoute.length) {
                    navRoute = [];
                    navRouteIndex = 0;
                    apOnRouteComplete();
                    sendMovement(0, 0);
                    return;
                }
                navigateTarget = { x: navRoute[navRouteIndex].x, y: navRoute[navRouteIndex].y };
                computePath();
                return;
            } else {
                navPath = [];
                navigateTarget = null;
                sendMovement(0, 0);
                return;
            }
        }
        const nextWp = navPath[navWaypointIndex];
        const nwx = (nextWp[0] + 0.5) * cSize;
        const nwy = (nextWp[1] + 0.5) * cSize;
        const ndx = nwx - botX;
        const ndy = nwy - botY;
        const len = Math.hypot(ndx, ndy) || 1;
        const wallDir = _wallAwareMove(ndx / len, ndy / len, botCX, botCY);
        sendMovement(wallDir.vx, wallDir.vy);
        return;
    }

    // Move toward current waypoint
    const wx = (wp[0] + 0.5) * cSize;
    const wy = (wp[1] + 0.5) * cSize;
    const dx = wx - botX;
    const dy = wy - botY;
    const dist = Math.hypot(dx, dy) || 1;
    const wallDir = _wallAwareMove(dx / dist, dy / dist, botCX, botCY);
    sendMovement(wallDir.vx, wallDir.vy);
}

// Recompute path if navigating (called after position updates)
let lastComputeCell = null;
function recomputePathIfNavigating() {
    if (!navigateTarget || navPath.length === 0 || _mobBlockDetouring) return;
    const cSize = serverMapSize / gridWidth;
    const sx = Math.floor(botX / cSize);
    const sy = Math.floor(botY / cSize);
    const key = sx + ',' + sy;
    if (lastComputeCell === key) return;
    lastComputeCell = key;
    computePath();
}

// Handle trigger loops after spawn is confirmed
function onSpawned() {
    console.log('\x1b[32m[Bot] SPAWNED into game! Starting movement AI loop...\x1b[0m');
    _resetStuck();
    apOnSpawned();

    // Drain any equip command that arrived before spawn
    _processPendingEquip();

    let ticks = 0;

    // Poll for commands from map viewer every 2 seconds (avoid leak by using tracked interval)
    if (!pollInterval) {
        pollInterval = setInterval(pollCommand, 2000);
    }

    // Movement AI Loop (33ms ≈ 30fps)
    movementInterval = setInterval(() => {
        if (!isSpawned) return;

        ticks++;
        if (ticks % 100 === 0) {
            if (botStats) {
                botStats.x = Math.round(botX);
                botStats.y = Math.round(botY);
            }
        }

        navigateTick();
    }, 33);
}

// Parse real-time coordinate updates from the server (Opcode 3)

// ━━━━━━ Pinky State Change Handler ━━━━━━
// Called when the bot's pinky status (bit 2048 in status flags) changes.
function onPinkyStateChanged(nowPinky) {
    if (nowPinky) {
        console.log(`\x1b[35m[Pinky] PINKY STATE ACQUIRED\x1b[0m`);
    } else {
        console.log(`\x1b[33m[Pinky] Pinky state lost.\x1b[0m`);
    }
    apOnPinkyState(nowPinky);
    // Broadcast immediately so web viewer updates
    broadcastMapData({ type: 'position', session: _currentSessionId, x: botX, y: botY, petals: botEquippedPetals, talents: botEquippedTalents, hp: botStats?.hpPercent, mana: botStats?.manaPercent, level: botStats?.level, isPinky, navPath: navPath.length > 0 ? navPath : undefined });
}

let botOutlierCount = 0;


// Helper to decode status flags
function decodeStatusFlags(flags) {
    const statuses = [];
    if (flags & 1) statuses.push("Wg");
    if (flags & 2) statuses.push("Lifesteal (br)");
    if (flags & 4) statuses.push("cp");
    if (flags & 8) statuses.push("Gg");
    if (flags & 64) statuses.push("Rg");
    if (flags & 128) statuses.push("tg");
    if (flags & 256) statuses.push("dg");
    if (flags & 512) statuses.push("qg");
    if (flags & 1024) statuses.push("Third Eye");
    if (flags & 2048) statuses.push("Pinky");
    if (flags & 4096) statuses.push("dp");
    if (flags & 8192) statuses.push("Invisible (_h)");
    if (flags & 16384) statuses.push("Yg");
    if (flags & 32768) statuses.push("mg");
    if (flags & 65536) statuses.push("Bandages");
    if (flags & 131072) statuses.push("Kg");
    if (flags & 262144) statuses.push("Xg");
    if (flags & 524288) statuses.push("Zg");
    if (flags & 1048576) statuses.push("jg");
    if (flags & 2097152) statuses.push("Jg");
    if (flags & 4194304) statuses.push("Qg");
    if (flags & 8388608) statuses.push("$g");
    if (flags & 16777216) statuses.push("Rh");
    if (flags & 33554432) statuses.push("ep");
    if (flags & 67108864) statuses.push("np");
    return statuses;
}

// Helper to filter and get all active petals orbiting around a player
// Helper to format equipped petals list cleanly
function formatEquippedPetalsList(petals) {
    if (petals.length === 0) return "None";
    const counts = {};
    for (const p of petals) {
        const key = `${p.rarityName} ${p.petalName}`;
        counts[key] = (counts[key] || 0) + 1;
    }
    return Object.entries(counts)
        .map(([name, count]) => `${name} x${count}`)
        .join(', ');
}

// Map of known entity IDs to their data (populated during spawn parsing)
let knownEntities = new Map(); // entityId -> { type, ... }
let activeMobs = new Map();    // Track active mobs on the map

// Session ID increments on every successful game-server connect. Included in
// every broadcast (position/mobs) so the viewer can filter out stale data
// from a previous (switched-out) server. Reset to -1 on the viewer during
// switch clearing.
let _currentSessionId = 0;

// Entity Type Constants (from D enum in zorr-deobfuscated.js line 848-864)
// D = M({ Entity:1, L:1, H:1, N:1, D:1, O:1, B:1, U:1, _:1, G:1, q:1, j:1, V:1, u:1, k:1 })
const ENTITY_TYPE = {
    ENTITY: 0,    // D.Entity - generic entity
    PLAYER: 1,    // D.L - Player
    PETAL: 2,     // D.H - Petal (orbiting item)
    MOB: 3,       // D.N - Mob (enemy/NPC)
    DROP: 4,      // D.D - Dropped petal on ground
    ZONE_O: 5,    // D.O
    ZONE_B: 6,    // D.B
    ZONE_U: 7,    // D.U
    UNDERSCORE: 8,// D._
    ZONE_G: 9,    // D.G
    ZONE_Q: 10,   // D.q
    WALL: 11,     // D.j - Wall/obstacle
    ZONE_V: 12,   // D.V
    LIGHTNING: 13, // D.u - Lightning effect
    EXPLOSION: 14  // D.k - Explosion effect
};

// Update bitmask flags (from N enum, Q() assigns power-of-2 values)
const UPDATE_FLAGS = {
    POSITION: 1,       // N.ae - x/y coordinate update
    ANGLE: 2,          // N.oe - angle update
    SIZE: 4,           // N.ie - size update
    DAMAGE: 8,         // N.se - damage flash (NOT death)
    LAYER: 16,         // N.re - layer/depth update
    STATUS: 32,        // N.le - status flags update (rY function)
    LEVEL: 64,         // N.de - level update
    FACE: 128,         // N.ce - face/pet update (j function)
    VG: 256,           // N.me - vg update
    GUILD: 512,        // N.he - guild update
    MANA: 1024,        // N.Mana - mana update
    GE: 2048,          // N.ge - ge flag
    HEALTH: 4096,      // N.Health - HP/mana update (i function)
    PE: 8192           // N.pe - pe flag (sub-entities)
};

// Decode petal/mob value into [itemIndex, rarityIndex] using ax=32 divisor
function decodeItemValue(val) {
    val = parseInt(val);
    return [Math.floor(val / 32), val % 32];
}

// Helper to read a length-prefixed string from the DataView
function readString(view, offset) {
    const len = view.getUint8(offset);
    offset += 1;
    if (offset + len > view.byteLength) {
        return { value: '', newOffset: offset };
    }
    let str = '';
    for (let i = 0; i < len; i++) {
        str += String.fromCharCode(view.getUint8(offset + i));
    }
    return { value: str, newOffset: offset + len };
}

// Helper to decompress coordinate value
function decompressCoord(raw) {
    return (raw - 3000) * 2;
}

function parseEntityUpdates(bytes) {
    if (bytes.length < 19) return; // Minimum header size
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    try {
        let v = 1; // Skip opcode byte

        // ═══════════════════════════════════════════════════
        // HEADER (matches source lines 41563-41571)
        // ═══════════════════════════════════════════════════
        const pq = view.getUint16(v); v += 2;   // Sequence number
        const nn = view.getUint32(v); v += 4;    // nn value
        const no = view.getUint16(v); v += 2;    // no value  
        const s7 = view.getUint32(v); v += 4;    // s7 value
        const camX = decompressCoord(view.getUint16(v)); v += 2; // Camera X
        const camY = decompressCoord(view.getUint16(v)); v += 2; // Camera Y

        // ═══════════════════════════════════════════════════
        // ENTITY ENTRIES (source lines 41576-41836)
        // Each entry: entityID(4) → if known: update, else: spawn
        // ═══════════════════════════════════════════════════
        const entityCount = view.getUint16(v); v += 2;

        for (let i = 0; i < entityCount && v + 4 <= bytes.length; i++) {
            const entityId = view.getUint32(v); v += 4;

            try {
                if (knownEntities.has(entityId)) {
                    // ═══ EXISTING ENTITY UPDATE (source lines 41583-41661) ═══
                    v = parseEntityUpdate(view, bytes, v, entityId);
                } else {
                    // ═══ NEW ENTITY SPAWN (source lines 41663-41825) ═══
                    v = parseEntitySpawn(view, bytes, v, entityId);
                }
            } catch (e) {
                console.log(`\x1b[33m[Parse] Error processing entity ${entityId}: ${e.message}\x1b[0m`);
                v += 4; // skip ahead and try to realign
            }

            if (v < 0 || v > bytes.length) break; // Safety: abort on parse error
        }

        // ═══════════════════════════════════════════════════
        // ENTITY DELETIONS (source lines 41838-41851)
        // Two deletion lists follow the entity entries
        // ═══════════════════════════════════════════════════
        if (v + 2 <= bytes.length) {
            const delCount1 = view.getUint16(v); v += 2;
            for (let i = 0; i < delCount1 && v + 4 <= bytes.length; i++) {
                const delId = view.getUint32(v); v += 4;
                knownEntities.delete(delId);
                activePetals.delete(delId);
                activeMobs.delete(delId);
            }
        }
        if (v + 2 <= bytes.length) {
            const delCount2 = view.getUint16(v); v += 2;
            for (let i = 0; i < delCount2 && v + 4 <= bytes.length; i++) {
                const delId = view.getUint32(v); v += 4;
                knownEntities.delete(delId);
                activePetals.delete(delId);
                activeMobs.delete(delId);
            }
        }

    } catch (e) {
        // Suppress parse errors - packet may be malformed or we may have misaligned
    }

    // Broadcast position and mob data to web viewer (only when alive and spawned)
    if ((isSpawned && !isDead) && (botX !== 0 || botY !== 0)) {
        const mobList = [];
        for (const [id, mob] of activeMobs) {
            if (mob.x !== undefined && mob.y !== undefined) {
                const dx = mob.x - botX;
                const dy = mob.y - botY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                mobList.push({
                    id,
                    x: mob.x,
                    y: mob.y,
                    name: mob.mobName || 'Unknown',
                    slug: mob.mobSlug || mob.mobName.toLowerCase().replace(/ /g, '_'),
                    rarity: mob.rarityIndex ?? 0,
                    variant: mob.variant ?? 0,
                    size: mob.size || 0,
                    dist: Math.round(dist)
                });
            }
        }
        // Sort by distance
        mobList.sort((a, b) => a.dist - b.dist);

        // Check tracking targets against visible mobs (only notify during auto-patrol)
        if (trackingTargets.length > 0 && trackingWebhookUrl && _AP.active && !_switching) {
            for (const mob of mobList) {
                for (const target of trackingTargets) {
                    if (mob.slug !== target.slug) continue;
                    if (target.enabled === false) continue;
                    if (target.variants && target.variants.length > 0 && !target.variants.includes(mob.variant)) continue;
                    if (target.rarities && target.rarities.length > 0 && !target.rarities.includes(mob.rarity)) continue;
                    const cellSz = serverMapSize / gridWidth;
                    const gridX = Math.floor(mob.x / cellSz);
                    const gridY = Math.floor(mob.y / cellSz);
                    const alreadyNotified = notifiedMobs.some(e =>
                        e.name === mob.name && e.variant === mob.variant && e.rarity === mob.rarity
                        && Math.abs(e.gridX - gridX) <= 2 && Math.abs(e.gridY - gridY) <= 2
                    );
                    if (alreadyNotified) continue;
                    notifiedMobs.push({ name: mob.name, variant: mob.variant, rarity: mob.rarity, gridX, gridY });
                    console.log(`\x1b[35m[Tracking] Match: ${mob.name} [V${mob.variant}] [R${mob.rarity}] at (${gridX},${gridY})\x1b[0m`);
                    sendDiscordAlert(mob);
                }
            }
        }

        broadcastMapData({ type: 'position', session: _currentSessionId, x: botX, y: botY, petals: botEquippedPetals, talents: botEquippedTalents, hp: botStats?.hpPercent, mana: botStats?.manaPercent, level: botStats?.level, isPinky, navPath: navPath.length > 0 ? navPath : undefined });
        broadcastMapData({ type: 'mobs', session: _currentSessionId, mobs: mobList });
        // Re-send map data periodically (every 5s) so the viewer always
        // has the grid even if the one-time login broadcast was lost.
        if (mapGrid && mapGrid.length > 0 && Date.now() - _lastMapBroadcast > 5000) {
            _lastMapBroadcast = Date.now();
            const _uMatch = serverUrl.match(/s-([a-z]+)-([a-z]+)\./);
            broadcastMapData({ type: 'map', session: _currentSessionId, mapName, biomeName, region: _uMatch ? _uMatch[1] : '', serverBiome: _uMatch ? _uMatch[2] : '', gridWidth, grid: mapGrid, mapSize: serverMapSize });
        }
    }
}

// Parse an EXISTING entity update (flags-based variable-length update)
function parseEntityUpdate(view, bytes, v, entityId) {
    if (v + 2 > bytes.length) return v;

    const flags = view.getUint16(v); v += 2;
    const entity = knownEntities.get(entityId);

    // N.ae (1) - Position update
    if (flags & UPDATE_FLAGS.POSITION) {
        if (v + 4 > bytes.length) return v;
        const x = decompressCoord(view.getUint16(v)); v += 2;
        const y = decompressCoord(view.getUint16(v)); v += 2;

        // Update tracking data
        if (entityId === botId) {
            if (botX !== 0 && botY !== 0) {
                const dx = Math.abs(x - botX);
                const dy = Math.abs(y - botY);
                if (dx > 5000 || dy > 5000) {
                    botOutlierCount++;
                    if (botOutlierCount < 5) { /* skip outlier but still parse */ }
                    else { botX = x; botY = y; botOutlierCount = 0; recomputePathIfNavigating(); }
                } else { botX = x; botY = y; botOutlierCount = 0; recomputePathIfNavigating(); }
            } else { botX = x; botY = y; recomputePathIfNavigating(); }
            if (botStats) { botStats.x = x; botStats.y = y; }
        } else if (activePetals.has(entityId)) {
            const pet = activePetals.get(entityId);
            pet.x = x; pet.y = y; pet.lastUpdated = Date.now();
        } else if (activeMobs.has(entityId)) {
            const mob = activeMobs.get(entityId);
            mob.x = x; mob.y = y; mob.lastUpdated = Date.now();
        }
    }

    // N.oe (2) - Angle update
    if (flags & UPDATE_FLAGS.ANGLE) {
        if (v + 1 > bytes.length) return v;
        v += 1; // angle byte
    }

    // N.ie (4) - Size update
    if (flags & UPDATE_FLAGS.SIZE) {
        if (v + 2 > bytes.length) return v;
        v += 2; // size uint16
    }

    // N.se (8) - Damage flash flag (game uses this for visual feedback only)
    if ((flags & UPDATE_FLAGS.DAMAGE) && entityId === botId && botStats) {
        // Damage flash indicator — no action needed
    }

    // N.re (16) - Layer update
    if (flags & UPDATE_FLAGS.LAYER) {
        if (v + 1 > bytes.length) return v;
        v += 1;
    }

    // N.le (32) - Status flags update (rY function: 4 bytes)
    if (flags & UPDATE_FLAGS.STATUS) {
        if (v + 4 > bytes.length) return v;
        const statusFlags = view.getUint32(v); v += 4;
        if (entityId === botId && botStats) {
            botStats.statusFlags = statusFlags;
            botStats.activeStatuses = decodeStatusFlags(statusFlags);
            // Pinky detection: check bit 2048 in status flags
            const wasPinky = isPinky;
            isPinky = !!(statusFlags & PINKY_BITMASK);
            if (isPinky !== wasPinky) {
                onPinkyStateChanged(isPinky);
            }
        }
    }

    // N.de (64) - Level update
    if (flags & UPDATE_FLAGS.LEVEL) {
        if (v + 2 > bytes.length) return v;
        const level = view.getUint16(v); v += 2;
        if (entityId === botId && botStats) botStats.level = level;
    }

    // N.ce (128) - Face/pet update (j function: face(1) + pet(1))
    if (flags & UPDATE_FLAGS.FACE) {
        if (v + 2 > bytes.length) return v;
        v += 2; // face + pet bytes
    }

    // N.me (256) - Vg update
    if (flags & UPDATE_FLAGS.VG) {
        if (v + 1 > bytes.length) return v;
        v += 1;
    }

    // N.he (512) - Guild update
    if (flags & UPDATE_FLAGS.GUILD) {
        if (v + 1 > bytes.length) return v;
        const res = readString(view, v);
        v = res.newOffset;
    }

    // N.Mana (1024) - Mana update
    if (flags & UPDATE_FLAGS.MANA) {
        if (v + 1 > bytes.length) return v;
        const mana = view.getUint8(v++) / 255;
        if (entityId === botId && botStats) botStats.manaPercent = (mana * 100).toFixed(1);
    }

    // N.ge (2048)
    if (flags & UPDATE_FLAGS.GE) {
        if (v + 1 > bytes.length) return v;
        v += 1;
    }

    // Sub-entity positions (snake segments etc) - if entity has Ir property
    // We check entity type to know if it has sub-entities
    if (entity && entity.snakeCount > 0) {
        for (let s = 0; s < entity.snakeCount; s++) {
            if (v + 4 > bytes.length) return v;
            v += 4; // x(2) + y(2) for each sub-entity
        }
    }

    // N.Health (4096) - HP + Mana update (i function: 2 bytes)
    if (flags & UPDATE_FLAGS.HEALTH) {
        if (v + 2 > bytes.length) return v;
        const hp = view.getUint8(v++) / 255;
        const mana = view.getUint8(v++) / 255;
        if (entityId === botId && botStats) {
            botStats.hpPercent = (hp * 100).toFixed(1);
            botStats.manaPercent = (mana * 100).toFixed(1);
        }
    }

    // N.pe (8192) - Sub-entity updates (4 bytes per sub-entity)
    if (flags & UPDATE_FLAGS.PE) {
        if (v + 1 > bytes.length) return v;
        const peMask = view.getUint8(v++);
        // A array has fixed length of exactly 6 (p, u, v, k, M, S)
        for (let bit = 0; bit < 6; bit++) {
            if (peMask & (1 << bit)) {
                if (v + 4 > bytes.length) return v;
                v += 4; // uint32 per sub-entity
            }
        }
    }

    return v;
}

// Parse a NEW entity spawn (type-specific variable-length data)
function parseEntitySpawn(view, bytes, v, entityId) {
    if (v + 1 > bytes.length) return v;

    const entityType = view.getUint8(v++);

    // Handle special types first (lightning, explosion) - they have unique formats
    // D.u = 13 (Lightning)
    if (entityType === ENTITY_TYPE.LIGHTNING) {
        if (v + 1 > bytes.length) return v;
        const pointCount = view.getUint8(v++);
        v += pointCount * 4; // Each point: x(2) + y(2)
        knownEntities.set(entityId, { type: entityType, snakeCount: 0 });
        return v;
    }

    // D.k = 14 (Explosion)
    if (entityType === ENTITY_TYPE.EXPLOSION) {
        v += 2 + 2 + 2 + 1; // x(2) + y(2) + size(2) + color(1) 
        knownEntities.set(entityId, { type: entityType, snakeCount: 0 });
        return v;
    }

    // For all other entity types: read common fields first
    // l (rarity/layer), x, y, size, angle
    if (v + 8 > bytes.length) return v;

    const layer = view.getUint8(v++);
    const x = decompressCoord(view.getUint16(v)); v += 2;
    const y = decompressCoord(view.getUint16(v)); v += 2;
    const size = view.getUint16(v); v += 2;
    const angle = view.getUint8(v++); // s() reads uint8 and converts

    let snakeCount = 0;

    switch (entityType) {
        case ENTITY_TYPE.PLAYER: { // D.L = 1
            // Read username, nickname, guild
            const username = readString(view, v); v = username.newOffset;
            const nickname = readString(view, v); v = nickname.newOffset;
            const guild = readString(view, v); v = guild.newOffset;

            // Status flags (rY function: 4 bytes)
            if (v + 4 > bytes.length) return v;
            const statusFlags = view.getUint32(v); v += 4;

            // Level (2 bytes)
            if (v + 2 > bytes.length) return v;
            const level = view.getUint16(v); v += 2;

            // Face + Pet (j function: 2 bytes)
            if (v + 2 > bytes.length) return v;
            const faceIdx = view.getUint8(v++);
            const petIdx = view.getUint8(v++);

            // Vg, Pg, Subclass
            if (v + 3 > bytes.length) return v;
            const vg = view.getUint8(v++);
            const pg = view.getUint8(v++) / 255;
            const subclass = view.getUint8(v++);

            // HP + Mana (i function: 2 bytes)
            if (v + 2 > bytes.length) return v;
            const hp = view.getUint8(v++) / 255;
            const mana = view.getUint8(v++) / 255;

            const activeStatuses = decodeStatusFlags(statusFlags);

            const statsObj = {
                entityId,
                rarity: layer,
                x, y, size, angle,
                username: username.value,
                nickname: nickname.value,
                guild: guild.value,
                statusFlags,
                activeStatuses,
                level,
                faceIdx,
                petIdx,
                vg,
                pg: pg.toFixed(2),
                subclass,
                hpPercent: (hp * 100).toFixed(1),
                manaPercent: (mana * 100).toFixed(1)
            };

            // Check if this is the bot
            if (entityId === botId) {
                const statsChanged = !botStats ||
                    botStats.level !== statsObj.level ||
                    botStats.hpPercent !== statsObj.hpPercent;
                botStats = statsObj;
                botX = x; botY = y; recomputePathIfNavigating();
                if (statsChanged) {
                    console.log(`\x1b[36m[AI] ★ My Bot Stats Spawned/Updated!\x1b[0m`);
                }
                // Pinky detection on spawn
                const wasPinky = isPinky;
                isPinky = !!(statusFlags & PINKY_BITMASK);
                if (isPinky !== wasPinky) {
                    onPinkyStateChanged(isPinky);
                }
            }
            break;
        }

        case ENTITY_TYPE.PETAL: { // D.H = 2
            if (v + 2 > bytes.length) return v;
            const petalVal = view.getUint16(v); v += 2;
            const [petalIndex, rarityIndex] = decodeItemValue(petalVal);

            const petalName = petalNames[petalIndex] || `UnknownPetal_${petalIndex}`;
            const rarityName = rarities[rarityIndex] ? rarities[rarityIndex].name : `Rarity_${rarityIndex}`;
            const rarityColor = rarities[rarityIndex] ? rarities[rarityIndex].color : "#ffffff";

            activePetals.set(entityId, {
                entityId, x, y, size,
                petalName, rarityName, rarityColor,
                petalIndex, rarityIndex,
                lastUpdated: Date.now()
            });
            break;
        }

        case ENTITY_TYPE.MOB: { // D.N = 3
            if (v + 2 > bytes.length) return v;
            const mobVal = view.getUint16(v); v += 2;
            const [mobIndex, mobRarityIndex] = decodeItemValue(mobVal);

            if (v + 2 > bytes.length) return v;
            const mobVariant = view.getUint8(v++);
            const mobFlags = view.getUint8(v++);

            const mobName = mobNames[mobIndex] || `UnknownMob_${mobIndex}`;
            const mobObj = mobNames[mobIndex] ? { name: mobName } : null;

            // Check for snake segments using dynamically detected snake mob indices
            if (snakeMobIndices.has(mobIndex)) {
                if (v + 1 > bytes.length) return v;
                const segCount = view.getUint8(v++);
                snakeCount = segCount;
                v += segCount * 4; // Each segment: x(2) + y(2)
            }

            // HP + Mana (i function: 2 bytes)
            if (v + 2 > bytes.length) return v;
            v += 2; // hp + mana

            activeMobs.set(entityId, {
                entityId, x, y, size,
                mobName,
                mobSlug: mobSlugs[mobIndex] || mobName.toLowerCase().replace(/ /g, '_'),
                mobIndex,
                rarityIndex: mobRarityIndex,
                variant: mobVariant,
                lastUpdated: Date.now()
            });
            break;
        }

        case ENTITY_TYPE.DROP: { // D.D = 4 - Dropped petal
            if (v + 6 > bytes.length) return v;
            v += 2; // petalVal (uint16)
            v += 4; // extra uint32
            break;
        }

        case ENTITY_TYPE.WALL: { // D.j = 11
            // No additional data
            break;
        }

        case ENTITY_TYPE.ENTITY: // D.Entity = 0
        case ENTITY_TYPE.ZONE_B: // D.B = 6
        case ENTITY_TYPE.ZONE_U: { // D.U = 7
            // No additional data, just set fg = entityType
            break;
        }

        case ENTITY_TYPE.UNDERSCORE: { // D._ = 8
            const str = readString(view, v); v = str.newOffset;
            break;
        }

        case ENTITY_TYPE.ZONE_G: { // D.G = 9
            if (v + 3 > bytes.length) return v;
            v += 2; // petalRef (uint16)
            v += 1; // flags byte
            break;
        }

        case ENTITY_TYPE.ZONE_Q: { // D.q = 10
            if (v + 1 > bytes.length) return v;
            v += 1; // flags byte
            break;
        }

        case ENTITY_TYPE.ZONE_O: { // D.O = 5
            if (v + 1 > bytes.length) return v;
            v += 1; // flags byte
            break;
        }

        case ENTITY_TYPE.ZONE_V: { // D.V = 12
            if (v + 9 > bytes.length) return v;
            v += 4; // uint32 * 1000
            v += 4; // uint32 * 1000
            v += 1; // boolean byte
            break;
        }

        default:
            // Entity types > 14 are always parse alignment errors
            if (entityType <= 14) {
                console.log(`\x1b[33m[Parse] Unknown entity type ${entityType} for ID ${entityId}\x1b[0m`);
            }
            break;
    }

    knownEntities.set(entityId, { type: entityType, snakeCount });
    return v;
}

// Start the bot client connection
async function init() {
    await ensureUbuntuFont();

    console.log('\x1b[1m\x1b[35m===================================================================');
    console.log('   Zorr Standalone WebSocket Bot Client (No Browser)');
    console.log(`   Server URL:              ${serverUrl}`);
    console.log(`   Player ID:               ${specifiedPlayerId || "Auto-Generated (Random)"}`);
    console.log('===================================================================\x1b[0m\n');

    // Fetch and parse game data from source (VM extraction via game_data_extractor)
    // P1: includeSource=true so the raw source is available for pinky detection
    // (avoids a redundant HTTPS fetch of the same JS file).
    try {
        console.log('[Init] Loading game data...');
        const { extractGameData } = require('./game_data_extractor');
        const gameData = await extractGameData({ includeSource: true });
        if (gameData.schemaVersion !== 2) {
            console.error(`\x1b[31m[Init] FATAL: Unsupported schema version ${gameData.schemaVersion}\x1b[0m`);
            process.exit(1);
        }

        // Set petal names (v2 schema: petals[] -> {id, name, slug})
        if (!gameData.petals || gameData.petals.length === 0) {
            console.error('\x1b[31m[Init] FATAL: Failed to parse petal names from game source\x1b[0m');
            process.exit(1);
        }
        petalNames = gameData.petals.map(p => p.name);

        // Build slug→ID map from extracted petal names
        slugToId = {};
        for (let i = 0; i < petalNames.length; i++) {
            slugToId[petalNames[i].toLowerCase().replace(/ /g, '_')] = i;
        }

        // Set mob names (v2 schema: mobs[] -> {id, name, slug, ...}) and snake indices
        if (!gameData.mobs || gameData.mobs.length === 0) {
            console.error('\x1b[31m[Init] FATAL: Failed to parse mob names from game source\x1b[0m');
            process.exit(1);
        }
        mobNames = gameData.mobs.map(m => m.name);
        mobSlugs = gameData.mobs.map(m => m.slug || m.name.toLowerCase().replace(/ /g, '_'));
        snakeMobIndices = new Set(gameData.snakeMobIndices || []);

        // Set rarities (v2 schema: rarities[] -> {id, name, color, weight, slug})
        if (!gameData.rarities || gameData.rarities.length === 0) {
            console.error('\x1b[31m[Init] FATAL: Failed to parse rarity definitions from game source\x1b[0m');
            process.exit(1);
        }
        rarities = gameData.rarities;

        console.log(`\x1b[32m[Init] Successfully loaded game data (v2):`);
        console.log(`  Petals: ${petalNames.length} entries`);
        console.log(`  Mobs:   ${mobNames.length} entries`);
        console.log(`  Rarities: ${rarities.length} entries`);
        console.log(`  Variants: ${(gameData.variants || []).length} entries`);
        console.log(`  Snake Mobs: ${snakeMobIndices.size} detected`);
        console.log(`  Source: ${gameData.sourceUrl}\x1b[0m\n`);

        // Dynamically verify pinky bitmask from game source
        // P1: Reuse the JS source that game_data_extractor already fetched
        //     (via includeSource=true) to avoid a redundant HTTPS fetch.
        try {
            const srcData = gameData._source;
            if (!srcData) {
                console.log(`\x1b[33m[Pinky] No source data available (includeSource=false). Using default bitmask 2048\x1b[0m`);
            } else {
                // Match pattern: .propName = !!(2048 & var) or .propName = !!(var & 2048)
                const pinkyMatch = srcData.match(/\.([a-zA-Z_$][\w$]*)\s*=\s*!!\(\s*(?:2048\s*&\s*[\w$]+|[\w$]+\s*&\s*2048)\s*\)/);
                if (pinkyMatch && pinkyMatch[1]) {
                    console.log(`\x1b[35m[Pinky] ✓ Dynamically detected pinky property: player.${pinkyMatch[1]} (bitmask 2048 confirmed, source reused)\x1b[0m`);
                    PINKY_BITMASK = 2048;
                } else {
                    console.log(`\x1b[33m[Pinky] Could not detect pinky property in source. Using default bitmask 2048\x1b[0m`);
                }
            }
        } catch (e) {
            console.log(`\x1b[33m[Pinky] Pinky detection init error: ${e.message}. Using default bitmask 2048\x1b[0m`);
        }

    } catch (err) {
        console.error(`\x1b[31m[Init] FATAL: Could not load game data: ${err.message}\x1b[0m`);
        process.exit(1);
    }

    // Extract protocol version from live game source via VM execution
    console.log('[Init] Extracting protocol version from live game source...');
    try {
        const { version, jsUrl } = await extractProtocolVersion();
        protocolVersion = version;
        console.log(`\x1b[32m[Init] ✓ Protocol version: ${protocolVersion} (from ${jsUrl})\x1b[0m`);
    } catch (e) {
        console.log(`\x1b[33m[Init] ⚠ Could not extract protocol version: ${e.message}. Using fallback: ${protocolVersion}\x1b[0m`);
    }

    // Start connection
    connect();

    // Start UDP listener for map_server discovery hello packets.
    // When a hello is received, open the SSE control stream for immediate
    // state/equip push. No polling, no retry spam — pure server-initiated.
    startControlDiscoveryListener();
}

init();

