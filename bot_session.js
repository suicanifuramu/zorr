const WebSocket = require('ws');
const { createCanvas, registerFont } = require('canvas');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const MAP_SERVER_URL = 'http://localhost:3000';
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 2 });
const CONTROL_DISCOVERY_PORT = 41235;
const _CONTROL_BACKOFF_INITIAL_MS = 2000;
const _CONTROL_BACKOFF_MAX_MS = 30000;

const OPCODE_SEND = {
    HANDSHAKE: 0, PING: 1, SPAWN_PLAY: 2, DIE_QUIT: 3, UNKNOWN_4: 4, MOVEMENT: 5,
    EQUIP_LOADOUT: 72, TALENT_RESET: 122, TALENT_APPLY: 123, CLAIM_STREAK: 16,
};
const BUILD_MAGIC = 1;
const BUILD_AX = 32;
const ENTITY_TYPE = { ENTITY:0, PLAYER:1, PETAL:2, MOB:3, DROP:4, ZONE_O:5, ZONE_B:6, ZONE_U:7, UNDERSCORE:8, ZONE_G:9, ZONE_Q:10, WALL:11, ZONE_V:12, LIGHTNING:13, EXPLOSION:14 };
const UPDATE_FLAGS = { POSITION:1, ANGLE:2, SIZE:4, DAMAGE:8, LAYER:16, STATUS:32, LEVEL:64, FACE:128, VG:256, GUILD:512, MANA:1024, GE:2048, HEALTH:4096, PE:8192 };
const _VARIANT_NAMES = ['Normal','Magic','Arcane','Cursed','Shiny','Corrupt','Radiant','Giant','Tiny','Charged','Elemental','Angelic','Demonic','Bloody','Sweet','Paranormal','Flash','Boss'];
const CENTER_COST = 25;
const _FRANTIC_DIRS = [[1,0],[1,-1],[0,-1],[-1,-1],[-1,0],[-1,1],[0,1],[1,1]];
const AP_LOG_MAX = 50;

const _talentData = require('./talent_data');
const talentSlugToId = {};
for (const t of _talentData) talentSlugToId[t.slug] = t.id;

class LCG {
    constructor(seed) { this.seed = seed >>> 0; }
    next() { this.seed = (this.seed * 1664525 + 1013904223) % 4294967296; return Math.floor(this.seed / 4294967296 * 255); }
}

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
                const l = 2*i+1, r = 2*i+2;
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
function decodeItemValue(val) { val = parseInt(val); return [Math.floor(val / 32), val % 32]; }
function decompressCoord(raw) { return (raw - 3000) * 2; }
function readString(view, offset) {
    const len = view.getUint8(offset); offset += 1;
    if (offset + len > view.byteLength) return { value: '', newOffset: offset };
    let str = '';
    for (let i = 0; i < len; i++) str += String.fromCharCode(view.getUint8(offset + i));
    return { value: str, newOffset: offset + len };
}
function decodeStatusFlags(flags) {
    const s = [];
    if (flags & 1) s.push("Wg"); if (flags & 2) s.push("Lifesteal"); if (flags & 4) s.push("cp");
    if (flags & 8) s.push("Gg"); if (flags & 64) s.push("Rg"); if (flags & 128) s.push("tg");
    if (flags & 256) s.push("dg"); if (flags & 512) s.push("qg"); if (flags & 1024) s.push("Third Eye");
    if (flags & 2048) s.push("Pinky"); if (flags & 4096) s.push("dp"); if (flags & 8192) s.push("Invisible");
    if (flags & 16384) s.push("Yg"); if (flags & 32768) s.push("mg"); if (flags & 65536) s.push("Bandages");
    if (flags & 131072) s.push("Kg"); if (flags & 262144) s.push("Xg");
    return s;
}
function getPrintableAscii(bytes) {
    let result = [], currentStr = '';
    for (const b of bytes) {
        if (b >= 32 && b <= 126) currentStr += String.fromCharCode(b);
        else { if (currentStr.length >= 3) result.push(currentStr); currentStr = ''; }
    }
    if (currentStr.length >= 3) result.push(currentStr);
    return result.join(' | ');
}
function buildDistanceMap(grid, rows, cols) {
    const dist = Array.from({ length: rows }, () => Array(cols).fill(Infinity));
    const queue = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (grid[y][x] === 0) { dist[y][x] = 0; queue.push([x, y]); }
    let head = 0;
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    while (head < queue.length) {
        const [x, y] = queue[head++];
        for (const [dx, dy] of dirs) {
            const nx = x+dx, ny = y+dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            if (dist[ny][nx] > dist[y][x] + 1) { dist[ny][nx] = dist[y][x] + 1; queue.push([nx, ny]); }
        }
    }
    return dist;
}
function decodeBuildCode(b64) {
    const raw = Buffer.from(b64, 'base64');
    if (raw.length < 8) return null;
    const magic = raw.readUInt32BE(0);
    if (magic !== BUILD_MAGIC) return null;
    const seed = raw.readUInt32BE(4);
    const data = raw.subarray(8);
    let lcgState = seed >>> 0;
    function lcgNext() { lcgState = (Math.imul(lcgState, 1664525) + 1013904223) >>> 0; return Math.floor(lcgState / 4294967296 * 255); }
    for (let i = 0; i < data.length; i++) data[i] ^= lcgNext() ^ lcgNext();
    for (let i = 0; i < data.length - 1; i += 2) { const tmp = data[i]; data[i] = data[i+1]; data[i+1] = tmp; }
    return JSON.parse(new TextDecoder().decode(data));
}

class BotSession {
    constructor(accountId, sharedData, botName) {
        this.accountId = accountId;
        this.botName = botName || '';
        this.serverUrl = 'wss://s-us-plains.zorr.pro/';

        // Shared read-only data
        this._petalNames = sharedData.petalNames;
        this._slugToId = sharedData.slugToId;
        this._mobNames = sharedData.mobNames;
        this._mobSlugs = sharedData.mobSlugs;
        this._snakeMobIndices = sharedData.snakeMobIndices;
        this._rarities = sharedData.rarities;
        this._PINKY_BITMASK = sharedData.PINKY_BITMASK;
        this._protocolVersion = sharedData.protocolVersion;

        // Connection
        this.ws = null;
        this._switching = false;
        this._switchingTimer = null;
        this._lastMapBroadcast = 0;
        this._connectEpoch = 0;
        this._connectCounter = 0;
        this._currentSessionId = 0;
        this.encryptor = null;
        this.lcgBytesSent = 0;
        this.equipSentTime = null;

        // Bot state
        this.botId = null;
        this.botX = 0;
        this.botY = 0;
        this.botStats = null;
        this.activePetals = new Map();
        this.botEquippedPetals = [];
        this.botEquippedTalents = [];
        this.botInventory = {};
        this.isSpawned = false;
        this.isDead = false;
        this.respawnState = '';
        this.returnToTitle = false;
        this.loggedIn = false;
        this.spawnSent = false;
        this.receivedOpcodes = new Set();
        this.streakData = { count: 0, lastClaimTime: 0, nextClaimDeadline: 0 };

        // Intervals
        this.pingInterval = null;
        this.movementInterval = null;
        this.pollInterval = null;

        // Map
        this.mapName = '';
        this.biomeName = '';
        this.gridWidth = 0;
        this.mapGrid = null;
        this.cellSize = 500;
        this.serverMapSize = 100000;
        this._distanceMap = null;

        // Entities
        this.knownEntities = new Map();
        this.activeMobs = new Map();
        this.botOutlierCount = 0;

        // Navigation
        this.navigateTarget = null;
        this.navPath = [];
        this.navWaypointIndex = 0;
        this.navRoute = [];
        this.navRouteIndex = 0;
        this.lastComputeCell = null;
        this._navWarned = { noGrid: false, oob: false, allWalls: false, noPath: false };

        // Stuck detection
        this._stuckCellKey = null;
        this._stuckSince = 0;
        this._franticMode = false;
        this._franticOriginCX = 0;
        this._franticOriginCY = 0;
        this._franticDirIndex = 0;
        this._franticDirEnd = 0;
        this._corruptInvert = false;
        this._mobBlockDefending = false;
        this._mobBlockDetouring = false;
        this._mobBlockDefendUntil = 0;
        this._mobBlockWPKey = '';

        // Auto patrol
        this._AP = { active: false, state: 'idle', pinkyFailCount: 0, moveDeathCount: 0, pinkyTimeout: null, servers: [], serverIndex: 0, buildSwitchTimeout: null, log: [], routes: {} };

        // Server toggles
        this.serverAttackToggled = false;
        this.serverDefendToggled = false;

        // Equip pending
        this._pendingEquipCmd = null;
        this._pendingEquipRetryTimer = null;

        // SSE control stream
        this._controlStreamReq = null;
        this._controlStreamReconnectTimer = null;
        this._controlStreamConnected = false;
        this._controlStreamBackoffMs = _CONTROL_BACKOFF_INITIAL_MS;
        this._controlDiscoveryMode = false;
        this._controlDiscoverySocket = null;

        // Tracking
        this.trackingTargets = [];
        this.trackingWebhookUrl = process.env.DISCORD_WEBHOOK_URL || '';
        this.notifiedMobs = [];

        // Broadcast
        this._broadcastBuffer = {};
        this._broadcastTimer = null;
        this._broadcastDown = false;
    }

    // ── Connection ──
    _bumpGeneration() {
        this._connectCounter = (this._connectCounter + 1) % 10;
        if (this._connectCounter === 0) this._connectEpoch++;
    }

    start(assignedServers) {
        this._initControlDiscoveryListener();
        this.connect();
        if (assignedServers && assignedServers.length > 0) {
            this._assignedServers = assignedServers;
        }
    }

    stop() {
        if (this.movementInterval) clearInterval(this.movementInterval);
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this._controlStreamReq) { try { this._controlStreamReq.destroy(); } catch(e) {} }
        if (this._controlDiscoverySocket) { try { this._controlDiscoverySocket.close(); } catch(e) {} }
        if (this.ws) { try { this.ws.close(); } catch(e) {} }
    }

    connect() {
        this._bumpGeneration();
        this._currentSessionId++;
        const myEpoch = this._connectEpoch;
        const myCounter = this._connectCounter;
        const tag = `[${this.accountId.slice(0,8)}]`;
        console.log(`${tag} [Bot] Connecting to ${this.serverUrl}... (gen=${myEpoch}:${myCounter})`);
        this.ws = new WebSocket(this.serverUrl, {
            origin: 'https://zorr.pro',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        this.ws.on('open', () => { this._sendHandshake(); });
        this.ws.on('message', (data) => { this._handleMessage(new Uint8Array(data)); });
        this.ws.on('close', (code, reason) => {
            if (myEpoch !== this._connectEpoch || myCounter !== this._connectCounter) return;
            const tag2 = `[${this.accountId.slice(0,8)}]`;
            console.log(`${tag2} [Bot] Connection closed (${code}). Reconnecting in 5s...`);
            if (this._AP.active && this._AP.state !== 'idle' && this._AP.state !== 'next_server') {
                console.log(`${tag2} [Bot] AP state was '${this._AP.state}', resetting to 'next_server'`);
                this._AP.state = 'next_server';
            }
            this._cleanup();
            setTimeout(() => this.connect(), 5000);
        });
        this.ws.on('error', (err) => {
            console.error(`[${this.accountId.slice(0,8)}] [Bot] WS Error: ${err.message}`);
        });
    }

    _cleanup() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.movementInterval) clearInterval(this.movementInterval);
        if (this.pollInterval) clearInterval(this.pollInterval);
        this.pingInterval = null; this.movementInterval = null; this.pollInterval = null;
        this.isSpawned = false; this.loggedIn = false; this.spawnSent = false;
        this.isDead = false; this.respawnState = '';
        this.receivedOpcodes = new Set();
        this.botId = null; this.botX = 0; this.botY = 0; this.botStats = null;
        this.activePetals.clear(); this.activeMobs.clear(); this.knownEntities.clear();
        this.botOutlierCount = 0; this.botEquippedPetals = []; this.botInventory = {};
        this.notifiedMobs.length = 0;
        this.navRoute = []; this.navRouteIndex = 0;
        this.navPath = []; this.navigateTarget = null;
    }

    switchBotServer(region, biome) {
        if (this._switching) return;
        this.notifiedMobs.length = 0;
        this._switching = true;
        const tag = `[${this.accountId.slice(0,8)}]`;
        if (this._switchingTimer) clearTimeout(this._switchingTimer);
        this._switchingTimer = setTimeout(() => {
            if (this._switching) { this._switching = false; console.log(`${tag} [Switch] Force reset _switching after 15s timeout`); }
        }, 15000);
        try {
            const postData = JSON.stringify({ type: 'switch', accountId: this.accountId, region, biome });
            http.request({ hostname: 'localhost', port: 3000, path: '/mapdata', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
            }, (res) => { res.resume(); }).on('error', () => {}).end(postData);
        } catch(_) {}
        for (const type of Object.keys(this._broadcastBuffer)) delete this._broadcastBuffer[type];
        if (this._broadcastTimer) { clearTimeout(this._broadcastTimer); this._broadcastTimer = null; }
        const newUrl = `wss://s-${region}-${biome}.zorr.pro/`;
        console.log(`${tag} [Switch] ${this.serverUrl} -> ${newUrl}`);
        this.serverUrl = newUrl;
        this._bumpGeneration();
        const oldWs = this.ws;
        if (oldWs) {
            let reconnected = false;
            const onClosed = () => {
                if (reconnected) return; reconnected = true;
                if (this._switchingTimer) { clearTimeout(this._switchingTimer); this._switchingTimer = null; }
                this._cleanup();
                setTimeout(() => { this._switching = false; this.connect(); }, 1000);
            };
            oldWs.once('close', onClosed);
            try { oldWs.close(); } catch(_) { onClosed(); }
        } else {
            if (this._switchingTimer) { clearTimeout(this._switchingTimer); this._switchingTimer = null; }
            this._switching = false; this.connect();
        }
    }

    // ── Send functions ──
    _sendEncrypted(packet) {
        if (!this.encryptor || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const encrypted = new Uint8Array(packet.length);
        for (let i = 0; i < packet.length; i++) encrypted[i] = packet[i] ^ this.encryptor.next();
        this.ws.send(encrypted);
        this.lcgBytesSent += packet.length;
    }

    _sendHandshake() {
        const seed = Math.floor(Math.random() * 4294967296);
        this.encryptor = new LCG(seed);
        const playerIdBytes = Buffer.from(this.accountId, 'ascii');
        const packetSize = 1 + 4 + 4 + 20 + playerIdBytes.length;
        const packet = new Uint8Array(packetSize);
        const view = new DataView(packet.buffer);
        let y = 0;
        view.setUint8(y++, OPCODE_SEND.HANDSHAKE);
        view.setUint32(y, this._protocolVersion); y += 4;
        view.setUint32(y, seed); y += 4;
        for (let i = 0; i < 20; i++) view.setUint8(y++, this.encryptor.next());
        packet.set(playerIdBytes, y);
        this.ws.send(packet);
        const tag = `[${this.accountId.slice(0,8)}]`;
        console.log(`${tag} [Handshake] Sent. Size: ${packet.length} bytes`);
    }

    _sendPing() { this._sendEncrypted(new Uint8Array([OPCODE_SEND.PING, 0])); }
    _sendSpawn(name) {
        const nameBytes = Buffer.from(name || '', 'utf-8');
        const packet = new Uint8Array(1 + nameBytes.length);
        packet[0] = OPCODE_SEND.SPAWN_PLAY;
        packet.set(nameBytes, 1);
        this._sendEncrypted(packet);
    }
    _sendDie() { this._sendEncrypted(new Uint8Array([OPCODE_SEND.DIE_QUIT])); }
    _sendClaimStreak() {
        this._sendEncrypted(new Uint8Array([OPCODE_SEND.CLAIM_STREAK]));
        this.streakData.lastClaimTime = Date.now();
        this.streakData.count += 1;
        this.streakData.nextClaimDeadline = Date.now() + 86400000;
        this._broadcastMapData({ type: 'daily-streak', session: this._currentSessionId, streakCount: this.streakData.count, lastClaimTime: this.streakData.lastClaimTime, nextClaimDeadline: this.streakData.nextClaimDeadline, canClaim: false });
    }
    _sendMovement(vx, vy, flags = 0) {
        if (this._corruptInvert) { vx = -vx; vy = -vy; }
        const xByte = Math.max(0, Math.min(255, Math.floor((vx * 0.5 + 0.5) * 255)));
        const yByte = Math.max(0, Math.min(255, Math.floor((vy * 0.5 + 0.5) * 255)));
        const actionFlags = flags | (this.serverAttackToggled ? 1 : 0) | (this.serverDefendToggled ? 2 : 0);
        this._sendEncrypted(new Uint8Array([OPCODE_SEND.MOVEMENT, xByte, yByte, actionFlags, 127]));
    }

    _sendTalentReset() { if (this.isSpawned) this._sendEncrypted(new Uint8Array([OPCODE_SEND.TALENT_RESET])); }
    _sendTalentApply(talentId) { if (this.isSpawned) this._sendEncrypted(new Uint8Array([OPCODE_SEND.TALENT_APPLY, talentId])); }
    _sendTalents(talentSlugs) {
        if (!Array.isArray(talentSlugs) || talentSlugs.length === 0) return;
        this._sendTalentReset();
        for (const slug of talentSlugs) { const id = talentSlugToId[slug]; if (id !== undefined) this._sendTalentApply(id); }
        this.botEquippedTalents = talentSlugs;
    }
    _sendEquipLoadout(buildObj) {
        if (!this.isSpawned) return;
        const topRow = buildObj.topRow || [];
        const bottomRow = buildObj.bottomRow || null;
        const totalSize = 3 + topRow.length * 2 + (bottomRow ? bottomRow.length * 2 : 0);
        const packet = new Uint8Array(totalSize);
        const view = new DataView(packet.buffer);
        let offset = 0;
        view.setUint8(offset++, OPCODE_SEND.EQUIP_LOADOUT);
        view.setUint8(offset++, bottomRow ? 1 : 0);
        view.setUint8(offset++, topRow.length);
        const encodeRow = (row) => {
            for (const entry of row) {
                let value = 0;
                if (entry) { const [slug, rarity] = entry; const petalId = this._slugToId[slug]; if (petalId !== undefined) value = petalId * BUILD_AX + rarity + 1; }
                view.setUint16(offset, value); offset += 2;
            }
        };
        encodeRow(topRow);
        if (bottomRow) encodeRow(bottomRow);
        this._sendEncrypted(packet);
        this.equipSentTime = Date.now();
        const newPetals = [];
        const addEntry = (entry) => { if (!entry) return; const [slug, rarityIdx] = entry; newPetals.push({ petalName: this._petalNames[this._slugToId[slug]] || slug, rarityName: this._rarities[rarityIdx]?.name || `R${rarityIdx}` }); };
        for (const entry of topRow) addEntry(entry);
        if (bottomRow) for (const entry of bottomRow) addEntry(entry);
        this.botEquippedPetals = newPetals;
        this._broadcastMapData({ type: 'position', session: this._currentSessionId, username: this.username, x: this.botX, y: this.botY, petals: this.botEquippedPetals, talents: buildObj.talents || [], hp: this.botStats?.hpPercent, mana: this.botStats?.manaPercent, level: this.botStats?.level, isPinky: this.isPinky, navPath: this.navPath.length > 0 ? this.navPath : undefined });
        if (buildObj.talents && buildObj.talents.length > 0) this._sendTalents(buildObj.talents);
    }

    // ── Broadcast ──
    _broadcastMapData(data) {
        if (this._switching && data.type !== 'auto-patrol') return;
        data.accountId = this.accountId;
        this._broadcastBuffer[data.type] = data;
        if (!this._broadcastTimer) this._broadcastTimer = setTimeout(() => this._flushBroadcast(), 100);
    }
    _sendDirectMapData(data) {
        data.accountId = this.accountId;
        const postData = JSON.stringify(data);
        try {
            const req = http.request({ hostname: 'localhost', port: 3000, path: '/mapdata', method: 'POST', agent: false,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
            }, (res) => { res.resume(); });
            req.on('error', () => {});
            req.end(postData);
        } catch(_) {}
    }
    _flushBroadcast() {
        this._broadcastTimer = null;
        const types = Object.keys(this._broadcastBuffer);
        for (const type of types) {
            const data = this._broadcastBuffer[type];
            delete this._broadcastBuffer[type];
            const postData = JSON.stringify(data);
            const req = http.request({ hostname: 'localhost', port: 3000, path: '/mapdata', method: 'POST', agent: false,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
            });
            let settled = false;
            req.on('response', (res) => { settled = true; res.resume(); if (this._broadcastDown) { this._broadcastDown = false; } });
            req.on('error', (e) => { if (settled) return; if (!this._broadcastDown) this._broadcastDown = true; this._broadcastBuffer[type] = data; if (!this._broadcastTimer) this._broadcastTimer = setTimeout(() => this._flushBroadcast(), 2000); });
            req.end(postData);
        }
    }

    // ── Equip ──
    _processPendingEquip() {
        if (!this._pendingEquipCmd) return;
        if (!this.isSpawned) {
            if (this._pendingEquipRetryTimer) return;
            this._pendingEquipRetryTimer = setTimeout(() => { this._pendingEquipRetryTimer = null; this._processPendingEquip(); }, 200);
            return;
        }
        const cmd = this._pendingEquipCmd;
        this._pendingEquipCmd = null;
        try {
            if (cmd.buildCode) {
                const build = decodeBuildCode(cmd.buildCode);
                if (build) { if (cmd.talents && cmd.talents.length > 0) build.talents = cmd.talents; this._sendEquipLoadout(build); }
            } else {
                const filePath = path.join(__dirname, cmd.buildFile || 'loadouts/move.txt');
                const b64 = fs.readFileSync(filePath, 'utf8').trim();
                const build = decodeBuildCode(b64);
                if (build) { if (cmd.talents && cmd.talents.length > 0) build.talents = cmd.talents; this._sendEquipLoadout(build); }
            }
        } catch (e) { console.log(`[${this.accountId.slice(0,8)}] [Bot] Equip error: ${e.message}`); }
    }

    _equipBuild(file) {
        this._pendingEquipCmd = { action: 'equip', buildFile: file, buildCode: null, talents: null };
        this._processPendingEquip();
    }

    // ── Handle control events from map_server ──
    _handleControlEvent(eventName, data) {
        const tag = `[${this.accountId.slice(0,8)}]`;
        if (eventName === 'state') {
            this.serverAttackToggled = !!data.attack;
            this.serverDefendToggled = !!data.defend;
        } else if (eventName === 'equip') {
            this._pendingEquipCmd = data;
            this._processPendingEquip();
        } else if (eventName === 'navigate') {
            if (data.action === 'stop') { this.navRoute = []; this.navRouteIndex = 0; this.navPath = []; this.navigateTarget = null; this._sendMovement(0, 0); return; }
            this.navigateTarget = { x: data.x, y: data.y };
            this._computePath();
        } else if (eventName === 'tracking') {
            this.trackingTargets = data.targets || [];
            if (data.webhookUrl) this.trackingWebhookUrl = data.webhookUrl;
        } else if (eventName === 'patrol') {
            const route = data.route || [];
            if (route.length > 0) { this.navRoute = route; this.navRouteIndex = 0; this.navigateTarget = { x: route[0].x, y: route[0].y }; this._computePath(); }
        } else if (eventName === 'command') {
            if (data.action === 'title') {
                if (!this.isDead && !this.respawnState && !this.returnToTitle) { this.isDead = true; this.isSpawned = false; this.navPath = []; this.navigateTarget = null; this.returnToTitle = true; this.respawnState = 'die_sent'; this._sendDie(); }
            } else if (data.action === 'spawn') {
                this.returnToTitle = false;
                if (!this.isSpawned && this.respawnState !== 'spawn_sent') { this._sendSpawn(this.botName); this.respawnState = 'spawn_sent'; }
            } else if (data.action === 'death') {
                if (!this.isDead && !this.respawnState) { this.isDead = true; this.isSpawned = false; this.navPath = []; this.navigateTarget = null; this.respawnState = 'die_sent'; this._sendDie(); }
            }
        } else if (eventName === 'auto-patrol') {
            console.log(`[${this.accountId.slice(0,8)}] [AP] SSE received: action=${data.action} servers=${data.servers?.length} switching=${this._switching} active=${this._AP.active} state=${this._AP.state}`);
            if (data.action === 'start' && data.servers) this.apStart(data.servers);
            else if (data.action === 'stop') this.apStop();
        } else if (eventName === 'daily-claim') {
            this._sendClaimStreak();
        }
    }

    // ── SSE Control Stream ──
    _connectControlStream(serverUrl) {
        if (this._controlStreamReq) { try { this._controlStreamReq.destroy(); } catch(e) {} }
        if (this._controlStreamReconnectTimer && !this._controlDiscoveryMode) { clearTimeout(this._controlStreamReconnectTimer); this._controlStreamReconnectTimer = null; }
        const baseUrl = serverUrl || MAP_SERVER_URL;
        const url = new URL('/control-stream', baseUrl);
        url.searchParams.set('accountId', this.accountId);
        const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET', agent: false,
            headers: { 'Accept': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' }
        }, (res) => {
            if (res.statusCode !== 200) { res.resume(); this._onStreamClosed(false); return; }
            this._controlStreamConnected = true;
            this._controlStreamBackoffMs = _CONTROL_BACKOFF_INITIAL_MS;
            let buffer = '', currentEvent = 'message', cleanupDone = false;
            const onClosed = (wasConnected) => {
                if (cleanupDone) return; cleanupDone = true;
                this._controlStreamConnected = false;
                if (this._controlStreamReq === req) this._controlStreamReq = null;
                this._scheduleControlReconnect();
            };
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                buffer += chunk;
                let idx;
                while ((idx = buffer.indexOf('\n\n')) !== -1) {
                    const raw = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
                    currentEvent = 'message';
                    let dataLines = [];
                    for (const line of raw.split('\n')) {
                        if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
                        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
                    }
                    if (dataLines.length === 0) continue;
                    try { this._handleControlEvent(currentEvent, JSON.parse(dataLines.join('\n'))); } catch(e) {}
                }
            });
            res.on('end', () => onClosed(true));
            res.on('close', () => onClosed(true));
            res.on('error', () => onClosed(true));
        });
        req.on('error', () => { this._controlStreamConnected = false; this._scheduleControlReconnect(); });
        req.end();
        this._controlStreamReq = req;
    }

    _onStreamClosed() { this._controlStreamConnected = false; this._scheduleControlReconnect(); }
    _scheduleControlReconnect() {
        if (this._controlDiscoveryMode && this._controlStreamConnected) return;
        if (this._controlStreamReconnectTimer) return;
        const delay = this._controlStreamBackoffMs;
        this._controlStreamBackoffMs = Math.min(this._controlStreamBackoffMs * 2, _CONTROL_BACKOFF_MAX_MS);
        this._controlStreamReconnectTimer = setTimeout(() => { this._controlStreamReconnectTimer = null; this._connectControlStream(); }, delay);
    }
    _initControlDiscoveryListener() {
        const socket = require('dgram').createSocket('udp4');
        let bound = false;
        socket.on('error', (e) => {
            const tag = `[${this.accountId.slice(0,8)}]`;
            console.log(`${tag} [Bot] UDP socket error: ${e.message}`);
            this._controlDiscoveryMode = false;
            this._scheduleControlReconnect();
        });
        socket.on('message', (buf) => {
            try {
                const parsed = JSON.parse(buf.toString('utf8'));
                if (parsed.type !== 'zorr-control-hello' || typeof parsed.url !== 'string') return;
                this._controlDiscoveryMode = true;
                if (this._controlStreamConnected) return;
                if (this._controlStreamReconnectTimer) { clearTimeout(this._controlStreamReconnectTimer); this._controlStreamReconnectTimer = null; }
                this._connectControlStream(parsed.url);
            } catch(e) {}
        });
        socket.bind(CONTROL_DISCOVERY_PORT, '127.0.0.1', () => { bound = true; this._controlDiscoverySocket = socket; this._controlDiscoveryMode = true; });
    }

    // ── Handle server messages ──
    _handleMessage(bytes) {
        if (bytes.length === 0) return;
        const opcode = bytes[0];
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (!this.receivedOpcodes.has(opcode)) {
            this.receivedOpcodes.add(opcode);
            const ascii = getPrintableAscii(bytes.slice(1));
            console.log(`[${this.accountId.slice(0,8)}] [Recv] Opcode 0x${opcode.toString(16).padStart(2,'0')} (${opcode}) Size:${bytes.length}${ascii ? ` [${ascii}]` : ''}`);
        }
        if (this.equipSentTime && (Date.now() - this.equipSentTime < 3000) && opcode === 109) this.equipSentTime = null;

        // Opcode 0: Kick
        if (opcode === 0) {
            const reasons = ["invalidProtocol","outdatedVersion","tooManyConnections","afk","loginFailed","banned","adminAction","restricted"];
            const tag = `[${this.accountId.slice(0,8)}]`;
            console.log(`${tag} ★ KICKED: ${reasons[bytes[1]] || bytes[1]}`);
            try { this.ws.close(); } catch(e) {}
        }

        // Opcode 1: Login Success
        if (opcode === 1) {
            this.loggedIn = true;
            if (bytes.length >= 5) this.botId = view.getUint32(1);
            try {
                let v = 1;
                v += 4; // rmId
                v += 1; // tFlags
                v += 2; // ez
                this.serverMapSize = view.getUint32(v); v += 4;
                v += 2; // kM
                v += 8; // skip high score
                const score = view.getUint32(v); v += 4;
                const usernameLen = view.getUint8(v);
                this.username = Buffer.from(bytes.buffer, bytes.byteOffset + v + 1, usernameLen).toString('utf8');
                v += 1 + usernameLen;
                const descLen = view.getUint16(v); v += 2; v += descLen;
                const lobbyFlag = view.getUint8(v++);
                const mapNameLen = view.getUint8(v++);
                this.mapName = Buffer.from(bytes.buffer, bytes.byteOffset + v, mapNameLen).toString('utf8'); v += mapNameLen;
                const biomeNameLen = view.getUint8(v++);
                this.biomeName = Buffer.from(bytes.buffer, bytes.byteOffset + v, biomeNameLen).toString('utf8'); v += biomeNameLen;
                this.gridWidth = view.getUint32(v); v += 4;
                const gridArea = this.gridWidth * this.gridWidth;
                const gridBytes = Math.ceil(gridArea / 8);
                this.mapGrid = [];
                for (let row = 0; row < this.gridWidth; row++) {
                    this.mapGrid[row] = [];
                    for (let col = 0; col < this.gridWidth; col++) {
                        const bitIdx = row * this.gridWidth + col;
                        this.mapGrid[row][col] = (bytes[v + Math.floor(bitIdx / 8)] >> (bitIdx % 8)) & 1;
                    }
                }
                v += gridBytes;
                this._distanceMap = buildDistanceMap(this.mapGrid, this.gridWidth, this.gridWidth);

                const slotsCount = view.getUint8(v++);
                this.botEquippedPetals = [];
                for (let t = 0; t < slotsCount * 2; t++) {
                    const val = view.getUint16(v) - 1; v += 2;
                    if (val !== -1) {
                        const [pi, ri] = decodeItemValue(val);
                        this.botEquippedPetals.push({ petalName: this._petalNames[pi] || `Petal_${pi}`, rarityName: this._rarities[ri]?.name || `R${ri}` });
                    }
                }
                const inventoryCount = view.getUint16(v); v += 2;
                this.botInventory = {};
                for (let t = 0; t < inventoryCount; t++) { const pk = view.getUint16(v); v += 2; const cnt = view.getUint32(v); v += 4; this.botInventory[pk] = cnt; }

                // Skip skins/mobSkins/talents
                v += view.getUint8(v++); // skins
                v += view.getUint8(v++); // mobSkins
                v += view.getUint8(v++); // talents

                // Streak data
                if (v + 10 <= bytes.length) {
                    this.streakData.count = view.getUint16(v); v += 2;
                    this.streakData.lastClaimTime = view.getUint32(v) * 1000; v += 4;
                    this.streakData.nextClaimDeadline = view.getUint32(v) * 1000; v += 4;
                }

                // Broadcast map
                const _urlMatch = this.serverUrl.match(/s-([a-z]+)-([a-z]+)\./);
                const _region = _urlMatch ? _urlMatch[1] : '';
                const _urlBiome = _urlMatch ? _urlMatch[2] : '';
                this._broadcastMapData({ type: 'map', session: this._currentSessionId, username: this.username, mapName: this.mapName, biomeName: this.biomeName, region: _region, serverBiome: _urlBiome, gridWidth: this.gridWidth, grid: this.mapGrid, mapSize: this.serverMapSize });
                this._recomputePathIfNavigating();
                this._broadcastMapData({ type: 'daily-streak', session: this._currentSessionId, streakCount: this.streakData.count, lastClaimTime: this.streakData.lastClaimTime, nextClaimDeadline: this.streakData.nextClaimDeadline, canClaim: this.streakData.lastClaimTime === 0 || Date.now() > this.streakData.nextClaimDeadline });
                this.apOnLogin();
            } catch (err) { console.error(`[${this.accountId.slice(0,8)}] Login parse error: ${err.message}`); }

            if (!this.pingInterval) this.pingInterval = setInterval(() => this._sendPing(), 1000);
            if (!this.spawnSent) {
                setTimeout(() => {
                    this._sendEncrypted(new Uint8Array([117, 30]));
                    this._sendEncrypted(new Uint8Array([104, 1]));
                    this._sendEncrypted(new Uint8Array([105, 1]));
                    this._sendEncrypted(new Uint8Array([118, 0]));
                    this._sendEncrypted(new Uint8Array([119, 0]));
                    this._sendSpawn(this.botName);
                    this.spawnSent = true;
                }, 500);
            }
        }

        // Opcode 3: Entity Updates
        if (opcode === 3) {
            this._parseEntityUpdates(bytes);
            if (this.respawnState === 'spawn_sent' && !this.isSpawned) { this.isSpawned = true; this.isDead = false; this.respawnState = ''; this.apOnSpawned(); }
            if (this.spawnSent && !this.isSpawned && !this.respawnState && !this.returnToTitle) { this.isSpawned = true; this._onSpawned(); }
        }

        // Opcode 11: Inventory/Stats
        if (opcode === 11) {
            try {
                let iv = 1; const invCount = view.getUint16(iv); iv += 2;
                if (invCount > 0 && 3 + invCount * 6 <= bytes.length) {
                    this.botInventory = {};
                    for (let t = 0; t < invCount && iv + 6 <= bytes.length; t++) { const pk = view.getUint16(iv); iv += 2; const cnt = view.getUint32(iv); iv += 4; this.botInventory[pk] = cnt; }
                }
            } catch(e) {}
        }

        // Opcode 4: Death
        if (opcode === 4) {
            if (!this.isDead) { this.isDead = true; this.isSpawned = false; this.navPath = []; this.navigateTarget = null; this._resetStuck(); }
            this.apOnDeath();
            this._sendDie();
            this.respawnState = 'die_sent';
        }

        // Opcode 5: Cleanup/Ready to respawn
        if (opcode === 5 && this.respawnState === 'die_sent') {
            if (this.returnToTitle) {
                this.respawnState = ''; this.isDead = false;
                this._broadcastMapData({ type: 'despawn', session: this._currentSessionId });
            } else {
                this._sendSpawn(this.botName);
                this.respawnState = 'spawn_sent';
            }
        }

        // Opcode 6: Revive
        if (opcode === 6) { this.isDead = false; this.isSpawned = true; this.returnToTitle = false; this.respawnState = ''; }
    }

    // ── Entity parsing ──
    _parseEntityUpdates(bytes) {
        if (bytes.length < 19) return;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        try {
            let v = 1;
            v += 2; v += 4; v += 2; v += 4; v += 2; v += 2; // header
            const entityCount = view.getUint16(v); v += 2;
            for (let i = 0; i < entityCount && v + 4 <= bytes.length; i++) {
                const entityId = view.getUint32(v); v += 4;
                try {
                    if (this.knownEntities.has(entityId)) v = this._parseEntityUpdate(view, bytes, v, entityId);
                    else v = this._parseEntitySpawn(view, bytes, v, entityId);
                } catch(e) { v += 4; }
                if (v < 0 || v > bytes.length) break;
            }
            // Deletions
            if (v + 2 <= bytes.length) { const dc = view.getUint16(v); v += 2; for (let i = 0; i < dc && v+4<=bytes.length; i++) { const did = view.getUint32(v); v+=4; this.knownEntities.delete(did); this.activePetals.delete(did); this.activeMobs.delete(did); } }
            if (v + 2 <= bytes.length) { const dc = view.getUint16(v); v += 2; for (let i = 0; i < dc && v+4<=bytes.length; i++) { const did = view.getUint32(v); v+=4; this.knownEntities.delete(did); this.activePetals.delete(did); this.activeMobs.delete(did); } }
        } catch(e) {}

        // Broadcast position + mobs
        if ((this.isSpawned && !this.isDead) && (this.botX !== 0 || this.botY !== 0)) {
            const mobList = [];
            for (const [id, mob] of this.activeMobs) {
                if (mob.x !== undefined && mob.y !== undefined) {
                    const dist = Math.sqrt((mob.x-this.botX)**2 + (mob.y-this.botY)**2);
                    mobList.push({ id, x: mob.x, y: mob.y, name: mob.mobName||'Unknown', slug: mob.mobSlug||mob.mobName.toLowerCase().replace(/ /g,'_'), rarity: mob.rarityIndex??0, variant: mob.variant??0, size: mob.size||0, dist: Math.round(dist) });
                }
            }
            mobList.sort((a,b) => a.dist - b.dist);

            // Tracking
            if (this.trackingTargets.length > 0 && this.trackingWebhookUrl && this._AP.active && !this._switching) {
                for (const mob of mobList) {
                    for (const target of this.trackingTargets) {
                        if (mob.slug !== target.slug || target.enabled === false) continue;
                        if (target.variants?.length > 0 && !target.variants.includes(mob.variant)) continue;
                        if (target.rarities?.length > 0 && !target.rarities.includes(mob.rarity)) continue;
                        const cellSz = this.serverMapSize / this.gridWidth;
                        const gridX = Math.floor(mob.x / cellSz), gridY = Math.floor(mob.y / cellSz);
                        if (this.notifiedMobs.some(e => e.name===mob.name && e.variant===mob.variant && e.rarity===mob.rarity && Math.abs(e.gridX-gridX)<=2 && Math.abs(e.gridY-gridY)<=2)) continue;
                        this.notifiedMobs.push({ name: mob.name, variant: mob.variant, rarity: mob.rarity, gridX, gridY });
                        this._sendDiscordAlert(mob);
                    }
                }
            }

            this._broadcastMapData({ type: 'position', session: this._currentSessionId, username: this.username, x: this.botX, y: this.botY, petals: this.botEquippedPetals, talents: this.botEquippedTalents, hp: this.botStats?.hpPercent, mana: this.botStats?.manaPercent, level: this.botStats?.level, isPinky: this.isPinky, navPath: this.navPath.length > 0 ? this.navPath : undefined });
            this._broadcastMapData({ type: 'mobs', session: this._currentSessionId, mobs: mobList });
            if (this.mapGrid && this.mapGrid.length > 0 && Date.now() - this._lastMapBroadcast > 5000) {
                this._lastMapBroadcast = Date.now();
                const um = this.serverUrl.match(/s-([a-z]+)-([a-z]+)\./);
                this._broadcastMapData({ type: 'map', session: this._currentSessionId, username: this.username, mapName: this.mapName, biomeName: this.biomeName, region: um?um[1]:'', serverBiome: um?um[2]:'', gridWidth: this.gridWidth, grid: this.mapGrid, mapSize: this.serverMapSize });
            }
        }
    }

    _parseEntityUpdate(view, bytes, v, entityId) {
        if (v+2>bytes.length) return v;
        const flags = view.getUint16(v); v+=2;
        const entity = this.knownEntities.get(entityId);
        if (flags & UPDATE_FLAGS.POSITION) {
            if (v+4>bytes.length) return v;
            const x = decompressCoord(view.getUint16(v)); v+=2;
            const y = decompressCoord(view.getUint16(v)); v+=2;
            if (entityId === this.botId) {
                if (this.botX !== 0 && this.botY !== 0) {
                    if (Math.abs(x-this.botX) > 5000 || Math.abs(y-this.botY) > 5000) { this.botOutlierCount++; if (this.botOutlierCount >= 5) { this.botX=x; this.botY=y; this.botOutlierCount=0; this._recomputePathIfNavigating(); } }
                    else { this.botX=x; this.botY=y; this.botOutlierCount=0; this._recomputePathIfNavigating(); }
                } else { this.botX=x; this.botY=y; this._recomputePathIfNavigating(); }
                if (this.botStats) { this.botStats.x=x; this.botStats.y=y; }
            } else if (this.activePetals.has(entityId)) { const p=this.activePetals.get(entityId); p.x=x; p.y=y; }
            else if (this.activeMobs.has(entityId)) { const m=this.activeMobs.get(entityId); m.x=x; m.y=y; }
        }
        if (flags & UPDATE_FLAGS.ANGLE) { if (v+1>bytes.length) return v; v+=1; }
        if (flags & UPDATE_FLAGS.SIZE) { if (v+2>bytes.length) return v; v+=2; }
        if (flags & UPDATE_FLAGS.LAYER) { if (v+1>bytes.length) return v; v+=1; }
        if (flags & UPDATE_FLAGS.STATUS) {
            if (v+4>bytes.length) return v;
            const sf = view.getUint32(v); v+=4;
            if (entityId === this.botId && this.botStats) {
                this.botStats.statusFlags = sf;
                const wasPinky = this.isPinky;
                this.isPinky = !!(sf & this._PINKY_BITMASK);
                if (this.isPinky !== wasPinky) this._onPinkyStateChanged(this.isPinky);
            }
        }
        if (flags & UPDATE_FLAGS.LEVEL) { if (v+2>bytes.length) return v; const lv = view.getUint16(v); v+=2; if (entityId===this.botId && this.botStats) this.botStats.level=lv; }
        if (flags & UPDATE_FLAGS.FACE) { if (v+2>bytes.length) return v; v+=2; }
        if (flags & UPDATE_FLAGS.VG) { if (v+1>bytes.length) return v; v+=1; }
        if (flags & UPDATE_FLAGS.GUILD) { if (v+1>bytes.length) return v; const r=readString(view,v); v=r.newOffset; }
        if (flags & UPDATE_FLAGS.MANA) { if (v+1>bytes.length) return v; const mn=view.getUint8(v++)/255; if (entityId===this.botId && this.botStats) this.botStats.manaPercent=(mn*100).toFixed(1); }
        if (flags & UPDATE_FLAGS.GE) { if (v+1>bytes.length) return v; v+=1; }
        if (entity && entity.snakeCount > 0) { for (let s=0;s<entity.snakeCount;s++) { if(v+4>bytes.length)return v; v+=4; } }
        if (flags & UPDATE_FLAGS.HEALTH) { if(v+2>bytes.length)return v; const hp=view.getUint8(v++)/255; const mn=view.getUint8(v++)/255; if(entityId===this.botId&&this.botStats){this.botStats.hpPercent=(hp*100).toFixed(1);this.botStats.manaPercent=(mn*100).toFixed(1);} }
        if (flags & UPDATE_FLAGS.PE) { if(v+1>bytes.length)return v; const pm=view.getUint8(v++); for(let b=0;b<6;b++){if(pm&(1<<b)){if(v+4>bytes.length)return v;v+=4;}} }
        return v;
    }

    _parseEntitySpawn(view, bytes, v, entityId) {
        if (v+1>bytes.length) return v;
        const entityType = view.getUint8(v++);
        if (entityType === ENTITY_TYPE.LIGHTNING) { if(v+1>bytes.length)return v; const pc=view.getUint8(v++); v+=pc*4; this.knownEntities.set(entityId,{type:entityType,snakeCount:0}); return v; }
        if (entityType === ENTITY_TYPE.EXPLOSION) { v+=7; this.knownEntities.set(entityId,{type:entityType,snakeCount:0}); return v; }
        if (v+8>bytes.length) return v;
        const layer = view.getUint8(v++);
        const x = decompressCoord(view.getUint16(v)); v+=2;
        const y = decompressCoord(view.getUint16(v)); v+=2;
        const size = view.getUint16(v); v+=2;
        const angle = view.getUint8(v++);
        let snakeCount = 0;

        switch(entityType) {
            case ENTITY_TYPE.PLAYER: {
                const un=readString(view,v); v=un.newOffset;
                const nn=readString(view,v); v=nn.newOffset;
                const gu=readString(view,v); v=gu.newOffset;
                if(v+4>bytes.length)return v; const sf=view.getUint32(v); v+=4;
                if(v+2>bytes.length)return v; const lv=view.getUint16(v); v+=2;
                if(v+2>bytes.length)return v; v+=2;
                if(v+3>bytes.length)return v; v+=3;
                if(v+2>bytes.length)return v; const hp=view.getUint8(v++)/255; const mn=view.getUint8(v++)/255;
                if(entityId===this.botId){
                    this.botStats={entityId,rarity:layer,x,y,size,angle,username:un.value,nickname:nn.value,guild:gu.value,statusFlags:sf,level:lv,hpPercent:(hp*100).toFixed(1),manaPercent:(mn*100).toFixed(1)};
                    this.botX=x; this.botY=y; this._recomputePathIfNavigating();
                    const wasPinky=this.isPinky; this.isPinky=!!(sf&this._PINKY_BITMASK);
                    if(this.isPinky!==wasPinky) this._onPinkyStateChanged(this.isPinky);
                }
                break;
            }
            case ENTITY_TYPE.PETAL: {
                if(v+2>bytes.length)return v; const pv=view.getUint16(v); v+=2;
                const [pi,ri]=decodeItemValue(pv);
                this.activePetals.set(entityId,{entityId,x,y,size,petalName:this._petalNames[pi]||`Petal_${pi}`,rarityName:this._rarities[ri]?.name||`R${ri}`,petalIndex:pi,rarityIndex:ri,lastUpdated:Date.now()});
                break;
            }
            case ENTITY_TYPE.MOB: {
                if(v+2>bytes.length)return v; const mv=view.getUint16(v); v+=2;
                const [mi,mri]=decodeItemValue(mv);
                if(v+2>bytes.length)return v; const mobVar=view.getUint8(v++); const mobFl=view.getUint8(v++);
                const mName=this._mobNames[mi]||`Mob_${mi}`;
                if(this._snakeMobIndices.has(mi)){if(v+1>bytes.length)return v; const sc=view.getUint8(v++); snakeCount=sc; v+=sc*4;}
                if(v+2>bytes.length)return v; v+=2;
                this.activeMobs.set(entityId,{entityId,x,y,size,mobName:mName,mobSlug:this._mobSlugs[mi]||mName.toLowerCase().replace(/ /g,'_'),mobIndex:mi,rarityIndex:mri,variant:mobVar,lastUpdated:Date.now()});
                break;
            }
            case ENTITY_TYPE.DROP: { if(v+6>bytes.length)return v; v+=6; break; }
            case ENTITY_TYPE.ZONE_O: { if(v+1>bytes.length)return v; v+=1; break; }
            case ENTITY_TYPE.ZONE_B:
            case ENTITY_TYPE.ZONE_U:
            case ENTITY_TYPE.WALL: { break; }
            case ENTITY_TYPE.UNDERSCORE: { const us=readString(view,v); v=us.newOffset; break; }
            case ENTITY_TYPE.ZONE_G: { if(v+3>bytes.length)return v; v+=3; break; }
            case ENTITY_TYPE.ZONE_Q: { if(v+1>bytes.length)return v; v+=1; break; }
            case ENTITY_TYPE.ZONE_V: { if(v+9>bytes.length)return v; v+=9; break; }
            default: break;
        }
        this.knownEntities.set(entityId,{type:entityType,snakeCount});
        return v;
    }

    // ── Pinky state ──
    _onPinkyStateChanged(nowPinky) {
        this.apOnPinkyState(nowPinky);
        this._broadcastMapData({ type:'position', session:this._currentSessionId, x:this.botX, y:this.botY, petals:this.botEquippedPetals, talents:this.botEquippedTalents, hp:this.botStats?.hpPercent, mana:this.botStats?.manaPercent, level:this.botStats?.level, isPinky:this.isPinky, navPath:this.navPath.length>0?this.navPath:undefined });
    }

    _onSpawned() {
        const tag = `[${this.accountId.slice(0,8)}]`;
        console.log(`${tag} [Bot] SPAWNED! Starting movement AI...`);
        this._resetStuck();
        this.apOnSpawned();
        this._processPendingEquip();
        if (!this.pollInterval) this.pollInterval = setInterval(() => this._pollCommand(), 2000);
        this.movementInterval = setInterval(() => {
            if (!this.isSpawned) return;
            this._navigateTick();
        }, 33);
    }

    _pollCommand() {
        const baseUrl = MAP_SERVER_URL;
        Promise.all([
            fetch(new URL('/command', baseUrl)).catch(()=>null),
            fetch(new URL('/state', baseUrl)).catch(()=>null),
        ]).then(([cmdRes, stateRes]) => {
            if (stateRes) return stateRes.json().then(s => { this.serverAttackToggled=!!s.attack; this.serverDefendToggled=!!s.defend; return cmdRes?cmdRes.json():null; });
            return cmdRes?cmdRes.json():null;
        }).then(cmd => {
            if (!cmd) return;
            if (cmd.action==='navigate') { this.navigateTarget={x:cmd.x,y:cmd.y}; this._computePath(); }
            else if (cmd.action==='death') { if(!this.isDead&&!this.respawnState){this.isDead=true;this.isSpawned=false;this.navPath=[];this.navigateTarget=null;this.respawnState='die_sent';this._sendDie();} }
            else if (cmd.action==='title') { if(!this.isDead&&!this.respawnState&&!this.returnToTitle){this.isDead=true;this.isSpawned=false;this.navPath=[];this.navigateTarget=null;this.returnToTitle=true;this.respawnState='die_sent';this._sendDie();} }
            else if (cmd.action==='spawn') { this.returnToTitle=false; if(!this.isSpawned&&this.respawnState!=='spawn_sent'){this._sendSpawn(this.botName);this.respawnState='spawn_sent';} }
            else if (cmd.action==='equip') { if(!this._pendingEquipCmd) this._pendingEquipCmd=cmd; }
            else if (cmd.type==='switch') { this.switchBotServer(cmd.region,cmd.biome); }
            else if (cmd.action==='patrol') { const r=cmd.route||[]; if(r.length>0){this.navRoute=r;this.navRouteIndex=0;this.navigateTarget={x:r[0].x,y:r[0].y};this._computePath();} }
        }).catch(()=>{});
    }

    // ── Navigation ──
    _resetStuck() {
        this._stuckCellKey=null; this._franticMode=false;
        this._mobBlockDetouring=false; this._mobBlockWPKey=''; this._mobBlockDefendUntil=0;
    }

    _computePath() {
        if (!this.mapGrid || !this.navigateTarget) return;
        const cSize = this.serverMapSize / this.gridWidth;
        const sx = Math.floor(this.botX / cSize), sy = Math.floor(this.botY / cSize);
        let ex = Math.floor(this.navigateTarget.x / cSize), ey = Math.floor(this.navigateTarget.y / cSize);
        const rows = this.mapGrid.length, cols = this.mapGrid[0].length;
        if (sx<0||sx>=cols||sy<0||sy>=rows) { this.navPath=[]; return; }
        ex = Math.max(0, Math.min(cols-1, ex)); ey = Math.max(0, Math.min(rows-1, ey));
        if (this.mapGrid[ey][ex] === 0) {
            let found=false, bestDist=Infinity, bx=ex, by=ey;
            for(let r=-2;r<=2;r++) for(let c=-2;c<=2;c++){const ny=ey+r,nx=ex+c;if(ny>=0&&ny<rows&&nx>=0&&nx<cols&&this.mapGrid[ny][nx]===1){const d=Math.hypot(nx-ex,ny-ey);if(d<bestDist){bestDist=d;bx=nx;by=ny;found=true;}}}
            if(found){ex=bx;ey=by;}else{this.navPath=[];return;}
        }
        const key=(x,y)=>x+','+y;
        const startKey=key(sx,sy), endKey=key(ex,ey);
        if(startKey===endKey){this.navPath=[];return;}
        const open=new MinHeap(); open.push({x:sx,y:sy,f:0,g:0});
        const openSet=new Set([startKey]), closedSet=new Set(), cameFrom={}, gScore={[startKey]:0};
        let found=false, iterations=0;
        while(open.size>0&&iterations++<50000){
            const cur=open.pop(); const ck=key(cur.x,cur.y);
            if(closedSet.has(ck))continue; closedSet.add(ck);
            if(ck===endKey){found=true;break;}
            for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
                if(dx===0&&dy===0)continue;
                const nx=cur.x+dx,ny=cur.y+dy;
                if(nx<0||nx>=cols||ny<0||ny>=rows)continue;
                if(this.mapGrid[ny][nx]===0)continue;
                if(dx!==0&&dy!==0&&(this.mapGrid[cur.y][nx]===0||this.mapGrid[ny][cur.x]===0))continue;
                const nk=key(nx,ny);
                if(closedSet.has(nk))continue;
                const bc=(dx!==0&&dy!==0)?1.414:1;
                const wd=this._distanceMap?this._distanceMap[ny][nx]:10;
                const mc=bc+CENTER_COST/(wd+1);
                const g=gScore[ck]+mc;
                if(g<(gScore[nk]??Infinity)){cameFrom[nk]=ck;gScore[nk]=g;open.push({x:nx,y:ny,f:g+Math.hypot(ex-nx,ey-ny),g});}
            }
        }
        if(!found){this.navPath=[];return;}
        const path=[]; let cur=endKey;
        while(cur){const [cx,cy]=cur.split(',').map(Number);path.push([cx,cy]);cur=cameFrom[cur];}
        path.reverse();
        this._stuckCellKey=null; this.navPath=path;
        let closestIdx=0, closestDist=Infinity;
        for(let i=0;i<path.length;i++){const d=Math.abs(path[i][0]-sx)+Math.abs(path[i][1]-sy);if(d<closestDist){closestDist=d;closestIdx=i;}}
        this.navWaypointIndex=closestIdx;
        this.lastComputeCell=sx+','+sy;
    }

    _recomputePathIfNavigating() {
        if(!this.navigateTarget||this.navPath.length===0||this._mobBlockDetouring)return;
        const cSize=this.serverMapSize/this.gridWidth;
        const sx=Math.floor(this.botX/cSize),sy=Math.floor(this.botY/cSize);
        const k=sx+','+sy;
        if(this.lastComputeCell===k)return;
        this.lastComputeCell=k;
        this._computePath();
    }

    _isCellBlockedByMob(cellX, cellY, cSize) {
        if(!this.activeMobs.size)return false;
        const cmx=cellX*cSize, cmy=cellY*cSize, cMx=(cellX+1)*cSize, cMy=(cellY+1)*cSize;
        for(const mob of this.activeMobs.values()){const r=mob.size||0;if(r<=0)continue;if(cmx>=mob.x-r&&cMx<=mob.x+r&&cmy>=mob.y-r&&cMy<=mob.y+r)return true;}
        return false;
    }

    _wallAwareMove(desiredVX, desiredVY, cx, cy) {
        if(!this.mapGrid||!this.mapGrid[0])return{vx:desiredVX,vy:desiredVY};
        const checkX=cx+(desiredVX>0.3?1:desiredVX<-0.3?-1:0);
        const checkY=cy+(desiredVY>0.3?1:desiredVY<-0.3?-1:0);
        const rows=this.mapGrid.length,cols=this.mapGrid[0].length;
        if(checkX>=0&&checkX<cols&&checkY>=0&&checkY<rows&&this.mapGrid[checkY][checkX]===1)return{vx:desiredVX,vy:desiredVY};
        const dirs=[[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
        let bestDot=-Infinity, bestDir=null;
        for(const [dx,dy] of dirs){
            const nx=cx+dx,ny=cy+dy;
            if(nx<0||nx>=cols||ny<0||ny>=rows)continue;
            if(this.mapGrid[ny][nx]===0)continue;
            if(dx!==0&&dy!==0&&(this.mapGrid[cy][nx]===0||this.mapGrid[ny][cx]===0))continue;
            const dlen=Math.hypot(dx,dy)||1;
            const dot=(dx/dlen)*desiredVX+(dy/dlen)*desiredVY;
            if(dot>bestDot){bestDot=dot;bestDir=[dx/dlen,dy/dlen];}
        }
        return bestDir?{vx:bestDir[0],vy:bestDir[1]}:{vx:desiredVX,vy:desiredVY};
    }

    _findNearestWallDir(cx, cy) {
        const dir=[[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
        let bestDist=Infinity, bestVX=1, bestVY=0;
        for(let dr=1;dr<=3;dr++) for(const [dx,dy] of dir){
            const nx=cx+dx*dr,ny=cy+dy*dr;
            if(nx<0||nx>=this.gridWidth||ny<0||ny>=this.gridWidth)continue;
            if(this.mapGrid[ny][nx]===1&&dr<bestDist){bestDist=dr;bestVX=-dx;bestVY=-dy;}
        }
        const len=Math.sqrt(bestVX*bestVX+bestVY*bestVY)||1;
        return{vx:bestVX/len,vy:bestVY/len};
    }

    _navigateTick() {
        // Defend phase: try to push through a blocked cell before attempting detour
        if(this._mobBlockDefending){
            if(Date.now()<this._mobBlockDefendUntil&&this.navigateTarget){
                this._corruptInvert=false;
                for(const mob of this.activeMobs.values()){if(mob.variant===5){this._corruptInvert=true;break;}}
                const cSize=this.serverMapSize/this.gridWidth;
                const dx=this.navigateTarget.x-this.botX, dy=this.navigateTarget.y-this.botY;
                const dist=Math.hypot(dx,dy)||1;
                const wd=this._wallAwareMove(dx/dist,dy/dist,Math.floor(this.botX/cSize),Math.floor(this.botY/cSize));
                this._sendMovement(wd.vx,wd.vy,2); return;
            }
            // Defend time expired; check if cell is still blocked
            this._mobBlockDefending=false;
            if(this.navigateTarget){
                const cSize=this.serverMapSize/this.gridWidth;
                const tgtCX=Math.floor(this.navigateTarget.x/cSize), tgtCY=Math.floor(this.navigateTarget.y/cSize);
                if(this._isCellBlockedByMob(tgtCX,tgtCY,cSize)){
                    // Defend failed → switch to detour
                    this._mobBlockDetouring=true;
                    const pv=this.mapGrid[tgtCY][tgtCX]; this.mapGrid[tgtCY][tgtCX]=0;
                    this._computePath(); this.mapGrid[tgtCY][tgtCX]=pv;
                    if(this.navPath.length===0){
                        console.log(`[MobBlock] No detour after defend, skip WP cell ${tgtCX},${tgtCY}`);
                        this._mobBlockDetouring=false; this._mobBlockWPKey='';
                        this.navRouteIndex++;
                        if(this.navRouteIndex>=this.navRoute.length){this.navRoute=[];this.navRouteIndex=0;this.apOnRouteComplete();this._sendMovement(0,0);return;}
                        this.navigateTarget={x:this.navRoute[this.navRouteIndex].x,y:this.navRoute[this.navRouteIndex].y};
                        this._computePath(); return;
                    }
                    console.log(`[MobBlock] Detour found after defend for cell ${tgtCX},${tgtCY}`);
                } else {
                    this._mobBlockWPKey='';
                }
            }
        }
        if(!this.isSpawned||(!this.navPath.length&&!this.navRoute.length)||(!this.navigateTarget&&this.navRoute.length===0)){this._sendMovement(0,0);return;}

        this._corruptInvert=false;
        for(const mob of this.activeMobs.values()){if(mob.variant===5){this._corruptInvert=true;break;}}
        const cSize=this.serverMapSize/this.gridWidth;
        const botCX=Math.floor(this.botX/cSize), botCY=Math.floor(this.botY/cSize);
        const cellKey=botCX+','+botCY, now=Date.now();

        // Frantic mode
        if(this._franticMode){
            if(Math.abs(botCX-this._franticOriginCX)>=2||Math.abs(botCY-this._franticOriginCY)>=2){
                this._franticMode=false; this._stuckCellKey=cellKey; this._stuckSince=now;
                if(this.navigateTarget) this._computePath();
            } else {
                if(now>=this._franticDirEnd){this._franticDirIndex=(this._franticDirIndex+1)%_FRANTIC_DIRS.length;this._franticDirEnd=now+300+Math.random()*500;}
                const d=_FRANTIC_DIRS[this._franticDirIndex]; this._sendMovement(d[0],d[1],2); return;
            }
        }
        if(this.navPath.length>0||this.navRoute.length>0){
            if(cellKey===this._stuckCellKey){
                if(now-this._stuckSince>3000){
                    this._franticMode=true; this._franticOriginCX=botCX; this._franticOriginCY=botCY;
                    this._franticDirIndex=0; this._franticDirEnd=now+300+Math.random()*500;
                    this._stuckCellKey=null; this._sendMovement(_FRANTIC_DIRS[0][0],_FRANTIC_DIRS[0][1],2); return;
                }
            } else { this._stuckCellKey=cellKey; this._stuckSince=now; }
        } else { this._stuckCellKey=null; this._stuckSince=now; }

        // Route patrol
        if(this.navRoute.length>0&&this.navRouteIndex<this.navRoute.length&&!this._mobBlockDetouring){
            const target=this.navRoute[this.navRouteIndex];
            const tCX=Math.floor(target.x/cSize), tCY=Math.floor(target.y/cSize);
            if(Math.abs(botCX-tCX)<=1&&Math.abs(botCY-tCY)<=1){
        this._mobBlockDefending=false; this._mobBlockDetouring=false; this._mobBlockWPKey=''; this._mobBlockDefendUntil=0;
                this.navRouteIndex++;
                if(this.navRouteIndex>=this.navRoute.length){this.navRoute=[];this.navRouteIndex=0;this.apOnRouteComplete();this._sendMovement(0,0);return;}
                this.navigateTarget={x:this.navRoute[this.navRouteIndex].x,y:this.navRoute[this.navRouteIndex].y};
                this._computePath(); return;
            }
            if(!this.navigateTarget||!this.navPath.length||Math.abs(this.navigateTarget.x-target.x)>1||Math.abs(this.navigateTarget.y-target.y)>1){
                this.navigateTarget={x:target.x,y:target.y}; this._computePath();
            }
        }

        // Mob-blocking: defend first, then detour
        if(this.navigateTarget&&this.navRoute.length>0&&!this._mobBlockDefending&&!this._mobBlockDetouring){
            const tgtCX=Math.floor(this.navigateTarget.x/cSize), tgtCY=Math.floor(this.navigateTarget.y/cSize);
            const wpKey=tgtCX+','+tgtCY;
            if(this._isCellBlockedByMob(tgtCX,tgtCY,cSize)){
                if(this._mobBlockWPKey!==wpKey){
                    this._mobBlockWPKey=wpKey; this._mobBlockDefending=true; this._mobBlockDefendUntil=Date.now()+1000;
                    console.log(`[MobBlock] Defending for 1s at ${wpKey}`);
                }
            } else {
                this._mobBlockWPKey='';
            }
        }

        if(!this.navPath.length||!this.navigateTarget){this._sendMovement(0,0);return;}
        const wp=this.navPath[this.navWaypointIndex];
        const tgtCX=Math.floor(this.navigateTarget.x/cSize), tgtCY=Math.floor(this.navigateTarget.y/cSize);
        if(Math.abs(botCX-tgtCX)<=1&&Math.abs(botCY-tgtCY)<=1){this._mobBlockDefending=false;this._mobBlockDetouring=false;this._mobBlockWPKey='';this.navPath=[];this.navigateTarget=null;this._sendMovement(0,0);return;}
        if(Math.abs(botCX-wp[0])<=1&&Math.abs(botCY-wp[1])<=1){
            this.navWaypointIndex++;
            if(this.navWaypointIndex>=this.navPath.length){
                if(this._mobBlockDetouring){this._mobBlockDetouring=false;this._mobBlockWPKey='';this.navPath=[];this.navigateTarget=null;this.navRouteIndex++;if(this.navRouteIndex>=this.navRoute.length){this.navRoute=[];this.navRouteIndex=0;this.apOnRouteComplete();this._sendMovement(0,0);return;}this.navigateTarget={x:this.navRoute[this.navRouteIndex].x,y:this.navRoute[this.navRouteIndex].y};this._computePath();return;}
                else{this.navPath=[];this.navigateTarget=null;this._sendMovement(0,0);return;}
            }
            const nwp=this.navPath[this.navWaypointIndex];
            const nwx=(nwp[0]+0.5)*cSize, nwy=(nwp[1]+0.5)*cSize;
            const ndx=nwx-this.botX, ndy=nwy-this.botY;
            const len=Math.hypot(ndx,ndy)||1;
            const wd=this._wallAwareMove(ndx/len,ndy/len,botCX,botCY);
            this._sendMovement(wd.vx,wd.vy); return;
        }
        const wx=(wp[0]+0.5)*cSize, wy=(wp[1]+0.5)*cSize;
        const ddx=wx-this.botX, ddy=wy-this.botY;
        const ddist=Math.hypot(ddx,ddy)||1;
        const wdd=this._wallAwareMove(ddx/ddist,ddy/ddist,botCX,botCY);
        this._sendMovement(wdd.vx,wdd.vy);
    }

    // ── Auto Patrol ──
    apLog(msg) {
        const line=`[${new Date().toLocaleTimeString()}] ${msg}`;
        this._AP.log.push(line);
        if(this._AP.log.length>AP_LOG_MAX) this._AP.log.shift();
        this._broadcastMapData({type:'auto-patrol',session:this._currentSessionId,state:this._AP.state,pinkyFailCount:this._AP.pinkyFailCount,moveDeathCount:this._AP.moveDeathCount,active:this._AP.active,currentServer:this._AP.servers[this._AP.serverIndex]||null,serverIndex:this._AP.serverIndex,serverCount:this._AP.servers.length,log:this._AP.log.slice(-10)});
    }
    apClearTimers() { if(this._AP.pinkyTimeout){clearTimeout(this._AP.pinkyTimeout);this._AP.pinkyTimeout=null;} if(this._AP.buildSwitchTimeout){clearTimeout(this._AP.buildSwitchTimeout);this._AP.buildSwitchTimeout=null;} }
    apStop() {
        this.apClearTimers(); this._AP.active=false; this._AP.state='idle';
        this._AP.pinkyFailCount=0; this._AP.moveDeathCount=0; this._AP.servers=[]; this._AP.serverIndex=0; this._AP.log=[];
        this.navRoute=[]; this.navRouteIndex=0; this.navPath=[]; this.navigateTarget=null;
        this._sendMovement(0,0); this.apLog('Auto Patrol STOPPED');
    }
    apStart(servers) {
        const tag = `[${this.accountId.slice(0,8)}]`;
        console.log(`${tag} [AP] apStart called: active=${this._AP.active} state=${this._AP.state} servers=${servers?.length}`);
        if(this._AP.active) this.apStop();
        this._AP.active=true; this._AP.servers=servers||[];
        this._AP.pinkyFailCount=0; this._AP.moveDeathCount=0;
        this._AP.state='next_server';
        const um=this.serverUrl.match(/s-([a-z]+)-([a-z]+)\./);
        if(um){const idx=this._AP.servers.findIndex(s=>s.region===um[1]&&s.biome===um[2]);this._AP.serverIndex=idx>=0?idx:0;}
        else this._AP.serverIndex=0;
        this.apLog(`Auto Patrol STARTED: ${this._AP.servers.length} servers, starting at ${this._AP.serverIndex}`);
        this._sendDirectMapData({type:'auto-patrol',session:this._currentSessionId,state:this._AP.state,pinkyFailCount:this._AP.pinkyFailCount,moveDeathCount:this._AP.moveDeathCount,active:this._AP.active,currentServer:this._AP.servers[this._AP.serverIndex]||null,serverIndex:this._AP.serverIndex,serverCount:this._AP.servers.length,log:this._AP.log.slice(-10)});
        this._fetchRoutes().then(()=>{console.log(`${tag} [AP] routes fetched, calling apAdvance`);this.apAdvance();}).catch(()=>{this.apLog('Route fetch failed');this.apAdvance();});
    }
    _fetchRoutes() {
        return new Promise((resolve,reject)=>{
            http.get('http://localhost:3000/routes',(res)=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{try{this._AP.routes=JSON.parse(body)||{};resolve();}catch(e){reject(e);}});}).on('error',reject);
        });
    }
    apAdvance() {
        if(!this._AP.active)return;
        if(this._AP.serverIndex>=this._AP.servers.length){this.apLog('All servers completed, looping');this._AP.serverIndex=0;}
        const srv=this._AP.servers[this._AP.serverIndex];
        if(!srv){this.apStop();return;}
        this.apLog(`→ ${srv.region}-${srv.biome} (${this._AP.serverIndex+1}/${this._AP.servers.length})`);
        this._AP.state='next_server';
        this.switchBotServer(srv.region,srv.biome);
    }
    apOnLogin() {
        const tag = `[${this.accountId.slice(0,8)}]`;
        if(!this._AP.active||this._AP.state!=='next_server'){console.log(`${tag} [AP] apOnLogin skip: active=${this._AP.active} state=${this._AP.state}`);return;}
        const routeKey=`${this.biomeName}-${this.mapName}`;
        const wp=this._AP.routes[routeKey];
        if(!wp||wp.length===0){this.apLog(`Skip: ${routeKey} (no route)`);this._AP.serverIndex++;return;}
        this.apLog(`Route: ${routeKey} (${wp.length} waypoints)`);
        this._AP.servers[this._AP.serverIndex].waypoints=wp;
        this._AP.servers[this._AP.serverIndex].routeKey=routeKey;
    }
    apOnSpawned() {
        const tag = `[${this.accountId.slice(0,8)}]`;
        console.log(`${tag} [AP] apOnSpawned: active=${this._AP.active} state=${this._AP.state}`);
        if(!this._AP.active)return;
        if(this._AP.state==='next_server'){
            const routeKey=`${this.biomeName}-${this.mapName}`;
            const wp=this._AP.routes[routeKey];
            if(!wp||wp.length===0){this.apLog(`No route for ${routeKey}, skip`);this._AP.serverIndex++;this.apAdvance();return;}
            this._AP.servers[this._AP.serverIndex].waypoints=wp;
            this._AP.servers[this._AP.serverIndex].routeKey=routeKey;
            this._AP.state='pinky_build';
            this.apLog(`Equipping pinky build`);
            this._equipBuild('loadouts/pinky.txt');
            this.apClearTimers();
            this._AP.pinkyTimeout=setTimeout(()=>{
                if(!this._AP.active||this._AP.state!=='wait_pinky')return;
                this._AP.pinkyFailCount++;
                if(this._AP.pinkyFailCount>=3){this._AP.serverIndex++;this.apAdvance();}
                else{this._triggerDeath();}
            },60000);
        } else if(this._AP.state==='pinky_build'){
            if(this.isPinky){
                this._AP.state='move_build';
                this.apLog(`Pinky detected, equipping move build`);
                this._equipBuild('loadouts/move.txt');
            }
            else{this._AP.state='wait_pinky';this.apLog(`Waiting for pinky`);}
        } else if(this._AP.state==='move_build'){
            this._AP.state='patrolling'; this._AP.pinkyFailCount=0; this._AP.moveDeathCount=0;
            this.apLog(`Patrolling`);
            const srv=this._AP.servers[this._AP.serverIndex];
            if(srv?.waypoints?.length>0){this.navRoute=srv.waypoints;this.navRouteIndex=0;this.navigateTarget={x:srv.waypoints[0].x,y:srv.waypoints[0].y};this._computePath();}
            else{this._AP.serverIndex++;this.apAdvance();}
        }
    }
    apOnPinkyState(nowPinky) {
        if(!this._AP.active||!nowPinky)return;
        if(this._AP.state==='wait_pinky'||this._AP.state==='pinky_build'){
            this.apClearTimers(); this._AP.state='move_build';
            this.apLog(`Pinky detected, equipping move build`);
            this._equipBuild('loadouts/move.txt');
            this._AP.state='patrolling'; this._AP.pinkyFailCount=0; this._AP.moveDeathCount=0;
            this.apLog(`Patrolling`);
            const srv=this._AP.servers[this._AP.serverIndex];
            if(srv?.waypoints?.length>0){this.navRoute=srv.waypoints;this.navRouteIndex=0;this.navigateTarget={x:srv.waypoints[0].x,y:srv.waypoints[0].y};this._computePath();}
            else{this._AP.serverIndex++;this.apAdvance();}
        }
    }
    apOnDeath() {
        if(!this._AP.active)return;
        if(this._AP.state==='wait_pinky'){
            this.apClearTimers(); this._AP.pinkyFailCount++;
            if(this._AP.pinkyFailCount>=3){this._AP.serverIndex++;this.apAdvance();}
        } else if(this._AP.state==='patrolling'){
            this._AP.moveDeathCount++;
            if(this._AP.moveDeathCount>=2){this.navRoute=[];this.navRouteIndex=0;this._AP.serverIndex++;this.apAdvance();}
            else{this.navRoute=[];this.navRouteIndex=0;this.navPath=[];this.navigateTarget=null;this._AP.state='next_server';}
        }
    }
    apOnRouteComplete() {
        if(!this._AP.active||this._AP.state!=='patrolling')return;
        this.apLog('Route complete! Next server');
        this._AP.serverIndex++; this.apAdvance();
    }
    _triggerDeath() {
        if(!this.isDead&&!this.respawnState){
            this.isDead=true; this.isSpawned=false;
            this.navPath=[]; this.navigateTarget=null; this.navRoute=[]; this.navRouteIndex=0;
            this.respawnState='die_sent'; this._sendDie();
        }
    }

    // ── Discord Alert ──
    _generateMobMapImage(mob, gridX, gridY) {
        if(!this.mapGrid||this.mapGrid.length===0)return null;
        const size=480, rows=this.mapGrid.length, cols=this.mapGrid[0].length;
        const cellPx=size/Math.max(rows,cols);
        const canvas=createCanvas(size,size); const ctx=canvas.getContext('2d');
        ctx.fillStyle='#0e1318'; ctx.fillRect(0,0,size,size);
        for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){ctx.fillStyle=this.mapGrid[r][c]===1?'#3a444f':'#1a2028';ctx.fillRect(c*cellPx,r*cellPx,cellPx,cellPx);}
        const mx=Math.max(10,Math.min(size-10,gridX*cellPx+cellPx/2));
        const my=Math.max(10,Math.min(size-10,gridY*cellPx+cellPx/2));
        ctx.beginPath(); ctx.arc(mx,my,5,0,Math.PI*2); ctx.fillStyle='#ffd700'; ctx.fill();
        const vName=_VARIANT_NAMES[mob.variant]||'';
        const rObj=this._rarities[mob.rarity];
        const label=`${mob.variant===0?'':vName+' '}${rObj?rObj.name:''} ${mob.name}`;
        ctx.font='bold 18px Ubuntu, monospace'; ctx.fillStyle='#ffd700'; ctx.textAlign='center';
        ctx.textBaseline='bottom'; ctx.fillText(label,mx,my-10);
        ctx.textBaseline='top'; ctx.fillText(`[${gridX},${gridY}]`,mx,my+10);
        return canvas.toBuffer('image/png');
    }
    _sendDiscordAlert(mob) {
        if(!this.trackingWebhookUrl)return;
        const cellSz=this.serverMapSize/this.gridWidth;
        const gridX=Math.floor(mob.x/cellSz), gridY=Math.floor(mob.y/cellSz);
        const um=this.serverUrl.match(/s-([a-z]+)-([a-z]+)\./);
        const region=um?um[1]:'', sbiome=um?um[2]:'';
        const vName=_VARIANT_NAMES[mob.variant]||`V${mob.variant}`;
        const rObj=this._rarities[mob.rarity];
        const rName=rObj?rObj.name:`R${mob.rarity}`;
        const content=`<@&1473497061981683876> ${rName.toLowerCase()} ${mob.variant===0?'':vName.toLowerCase()+' '}${mob.name.toLowerCase()} ${region}-${sbiome} ${gridX} ${gridY}`;
        const imgBuf=this._generateMobMapImage(mob,gridX,gridY);
        const webhookUrl=new URL(this.trackingWebhookUrl);
        if(imgBuf){
            const boundary='----ZorrBot'+Date.now();
            const pre=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({content})}\r\n`);
            const filePart=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="map.png"\r\nContent-Type: image/png\r\n\r\n`);
            const post=Buffer.from(`\r\n--${boundary}--\r\n`);
            const body=Buffer.concat([pre,filePart,imgBuf,post]);
            const req=https.request({hostname:webhookUrl.hostname,port:443,path:webhookUrl.pathname+webhookUrl.search,method:'POST',headers:{'Content-Type':`multipart/form-data; boundary=${boundary}`,'Content-Length':body.length}},(res)=>{res.resume();});
            req.on('error',()=>{}); req.end(body);
        } else {
            const body=JSON.stringify({content});
            const req=https.request({hostname:webhookUrl.hostname,port:443,path:webhookUrl.pathname+webhookUrl.search,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},(res)=>{res.resume();});
            req.on('error',()=>{}); req.end(body);
        }
    }
}

module.exports = { BotSession, buildDistanceMap, decodeBuildCode, decodeItemValue };
