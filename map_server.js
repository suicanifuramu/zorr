const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { getOrComputeExtraction, invalidateCache } = require('./extraction_pipeline');

// Load .env for DISCORD_WEBHOOK_URL
try {
    require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (e) { /* dotenv not available, ignore */ }

const PORT = 3000;
const CONTROL_DISCOVERY_PORT = 41235; // UDP port for "I'm here" broadcast to bot
let latestData = { map: null, position: null, mobs: null, config: null, 'daily-streak': null };
let clients = [];
let commandQueue = []; // FIFO queue: [{ action, ... }, ...]
let attackToggled = false; // Persistent attack state (bit 0 of action_flags in Opcode 5)
let defendToggled = false; // Persistent defend state (bit 1 of action_flags in Opcode 5)
let gameConfig = null;
let lastExtractionError = null;
// Multi-bot: Map<accountId, { client, latestData }>
const botSessions = new Map();
let controlDiscoverySocket = null; // UDP socket for broadcasting presence to bot
let controlDiscoveryInterval = null; // 3s heartbeat interval
const _loggedTypes = new Set(); // dedupe: log first /mapdata per type, then silent
let _loggedDeadClient = false; // dedupe: log first dead SSE client, then silent

// Routes storage
const ROUTES_PATH = path.join(__dirname, 'routes.json');
let customRoutes = {};
try {
    if (fs.existsSync(ROUTES_PATH)) {
        const raw = fs.readFileSync(ROUTES_PATH, 'utf8').replace(/^\uFEFF/, '');
        customRoutes = JSON.parse(raw);
        console.log(`[MapServer] Loaded ${Object.keys(customRoutes).length} routes`);
    }
} catch (e) { /* ignore */ }

function saveRoutes() {
    try { fs.writeFileSync(ROUTES_PATH, JSON.stringify(customRoutes, null, 2)); } catch (e) { /* ignore */ }
}

// Tracking config (targets + webhook URL)
const TRACKING_CONFIG_PATH = path.join(__dirname, 'tracking_config.json');
let trackingConfig = { targets: [] };
try {
    if (fs.existsSync(TRACKING_CONFIG_PATH)) {
        const rawCfg = fs.readFileSync(TRACKING_CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
        trackingConfig = JSON.parse(rawCfg);
        console.log(`[MapServer] Loaded tracking config: ${trackingConfig.targets.length} targets`);
    }
} catch (e) { /* ignore parse errors */ }

function saveTrackingConfig() {
    try {
        fs.writeFileSync(TRACKING_CONFIG_PATH, JSON.stringify(trackingConfig, null, 2));
    } catch (e) { /* ignore write errors */ }
}

function pushTrackingConfigToBot() {
    const payload = { ...trackingConfig, webhookUrl: process.env.DISCORD_WEBHOOK_URL || '' };
    for (const [id, session] of botSessions) {
        if (session?.client) {
            try { session.client.write(`event: tracking\ndata: ${JSON.stringify(payload)}\n\n`); } catch(e) {}
        }
    }
}

// Helper: send event to all bots, or a specific bot if accountId is provided
function _sendToBots(eventType, data, accountId) {
    const msg = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    if (accountId) {
        const session = botSessions.get(accountId);
        if (session?.client) { try { session.client.write(msg); } catch(e) {} }
    } else {
        for (const [id, session] of botSessions) {
            if (session?.client) { try { session.client.write(msg); } catch(e) {} }
        }
    }
}

// Broadcast "I'm here" over UDP so bot_client_2 can detect map_server startup
// without having to poll. Bot listens on CONTROL_DISCOVERY_PORT and opens the
// SSE connection when it receives a hello.
function startControlDiscovery() {
    try {
        controlDiscoverySocket = dgram.createSocket('udp4');
        controlDiscoverySocket.on('error', (e) => {
            console.log(`\x1b[33m[MapServer] Control discovery socket error: ${e.message}\x1b[0m`);
        });
        controlDiscoverySocket.bind(0, '127.0.0.1', () => {
            const msg = Buffer.from(JSON.stringify({
                type: 'zorr-control-hello',
                url: `http://localhost:${PORT}`,
                pid: process.pid,
                ts: Date.now(),
            }));
            const send = () => {
                if (!controlDiscoverySocket) return;
                try {
                    controlDiscoverySocket.send(msg, CONTROL_DISCOVERY_PORT, '127.0.0.1');
                } catch (e) { /* ignore send errors */ }
            };
            send();
            controlDiscoveryInterval = setInterval(send, 3000);
            controlDiscoveryInterval.unref();
            console.log(`\x1b[36m[MapServer] Broadcasting control discovery on UDP 127.0.0.1:${CONTROL_DISCOVERY_PORT} (every 3s)\x1b[0m`);
        });
    } catch (e) {
        console.log(`\x1b[33m[MapServer] Failed to start control discovery: ${e.message}\x1b[0m`);
    }
}

// Always extract fresh from zorr.pages.dev at startup.
// Uses the unified pipeline (shared with protocol_extractor / game_data_extractor).
async function refreshConfig() {
    try {
        const full = await getOrComputeExtraction({ includeProtocol: true });
        gameConfig = {
            schemaVersion: 2,
            extractedAt: full.fetchedAt,
            sourceUrl: full.jsUrl,
            protocolVersion: full.protocolVersion,
            vmRunMs: full.vmRunMs,
            rarities: full.rarities,
            variants: full.variants,
            petals: full.petals,
            mobs: full.mobs,
            talents: full.talents || [],
            biomeMobs: full.biomeMobs || {},
            regions: full.regions || [],
            biomes: full.biomes || [],
            snakeMobIndices: full.snakeMobIndices,
            snakeMethod: full.snakeMethod,
        };
        latestData.config = { type: 'config', ...gameConfig };
        console.log(`\x1b[32m[MapServer] Game config loaded: ${gameConfig.petals.length} petals, ${gameConfig.mobs.length} mobs, ${gameConfig.talents.length} talents, ${gameConfig.variants.length} variants, ${gameConfig.rarities.length} rarities, ${gameConfig.regions.length} regions, ${gameConfig.biomes.length} biomes, protocol=${gameConfig.protocolVersion} (${gameConfig.vmRunMs}ms VM, ${gameConfig.snakeMobIndices.length} snakes via ${gameConfig.snakeMethod})\x1b[0m`);
        lastExtractionError = null;
        return gameConfig;
    } catch (e) {
        lastExtractionError = e.message;
        console.error(`\x1b[31m[MapServer] Failed to extract game config: ${e.message}\x1b[0m`);
        return null;
    }
}

// Initial extraction (sequential, blocks startup briefly)
refreshConfig().then(() => {
    if (!gameConfig) {
        console.error(`\x1b[31m[MapServer] WARNING: Server starting without game config. /config will return 503.\x1b[0m`);
    }
});

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.url === '/' && req.method === 'GET') {
        const htmlPath = path.join(__dirname, 'map.html');
        if (fs.existsSync(htmlPath)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            fs.createReadStream(htmlPath).pipe(res);
        } else {
            res.writeHead(404);
            res.end('map.html not found');
        }
        return;
    }

    if (req.url === '/config' && req.method === 'GET') {
        res.setHeader('Cache-Control', 'no-store');
        if (gameConfig) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(gameConfig));
        } else {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: lastExtractionError || 'Game config not yet loaded' }));
        }
        return;
    }

    if (req.url === '/config/refresh' && req.method === 'POST') {
        res.setHeader('Content-Type', 'application/json');
        invalidateCache();
        refreshConfig().then(c => {
            if (c) {
                res.end(JSON.stringify({ ok: true, schemaVersion: c.schemaVersion, vmRunMs: c.vmRunMs, snakeMethod: c.snakeMethod }));
            } else {
                res.writeHead(500);
                res.end(JSON.stringify({ error: lastExtractionError || 'unknown' }));
            }
        });
        return;
    }

    if (req.url === '/events' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        clients.push(res);
        console.log(`[MapServer] Client connected (${clients.length} total)`);

        if (latestData.config) res.write(`data: ${JSON.stringify(latestData.config)}\n\n`);
        if (latestData.map) res.write(`data: ${JSON.stringify(latestData.map)}\n\n`);
        if (latestData.position) res.write(`data: ${JSON.stringify(latestData.position)}\n\n`);
        if (latestData.mobs) res.write(`data: ${JSON.stringify(latestData.mobs)}\n\n`);
        if (latestData['daily-streak']) res.write(`data: ${JSON.stringify(latestData['daily-streak'])}\n\n`);

        req.on('close', () => {
            clients = clients.filter(c => c !== res);
        });
        return;
    }

    if (req.url.startsWith('/control-stream') && req.method === 'GET') {
        // Parse accountId from query string
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const accountId = parsedUrl.searchParams.get('accountId') || 'default';

        // Close previous connection for same accountId
        const existing = botSessions.get(accountId);
        if (existing) { try { existing.client.end(); } catch(e) {} }

        const sessionData = { client: res, latestData: { map: null, position: null, mobs: null, config: null, 'daily-streak': null, 'auto-patrol': null } };
        botSessions.set(accountId, sessionData);

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        // Initial state push
        res.write(`event: state\ndata: ${JSON.stringify({ attack: attackToggled, defend: defendToggled })}\n\n`);
        if (trackingConfig.targets.length > 0) {
            res.write(`event: tracking\ndata: ${JSON.stringify({ ...trackingConfig, webhookUrl: process.env.DISCORD_WEBHOOK_URL || '' })}\n\n`);
        }
        console.log(`[MapServer] Bot connected: ${accountId.slice(0,8)}`);

        req.on('close', () => {
            if (botSessions.get(accountId)?.client === res) {
                botSessions.delete(accountId);
                // Clear this account's data from all viewers
                const snapshot = clients.slice();
                for (const client of snapshot) {
                    try { client.write(`data: ${JSON.stringify({ type: 'account-disconnect', accountId })}\n\n`); } catch(e) { try{client.end();}catch(_){} clients=clients.filter(c=>c!==client); }
                }
            }
            console.log(`[MapServer] Bot disconnected: ${accountId.slice(0,8)}`);
        });
        return;
    }

    if (req.url === '/mapdata' && req.method === 'GET') {
        // Return all accounts' cached data as a single snapshot.
        const allData = {};
        for (const [id, session] of botSessions) {
            allData[id] = session.latestData;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(allData));
        return;
    }

    if (req.url === '/mapdata' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const accountId = data.accountId || 'default';
                const session = botSessions.get(accountId);
                if (!session) {
                    // No bot session yet, store globally as fallback
                    if (!_loggedTypes.has('no-session-' + accountId)) {
                        _loggedTypes.add('no-session-' + accountId);
                        console.log(`[MapServer] No session for ${accountId.slice(0,8)}, data stored globally`);
                    }
                }
                const target = session ? session.latestData : latestData;
                target[data.type] = data;
                if (data.type === 'despawn') target.position = null;
                if (data.type === 'switch') { target.mobs = null; target.map = null; target.position = null; target['auto-patrol'] = null; }
                // Store username from map or position broadcasts
                if (session && data.username) {
                    session.username = data.username;
                }

                // Broadcast to all viewers with accountId
                const broadcastData = { ...data, accountId };
                const snapshot = clients.slice();
                for (const client of snapshot) {
                    try { client.write(`data: ${JSON.stringify(broadcastData)}\n\n`); } catch(e) { try{client.end();}catch(_){} clients=clients.filter(c=>c!==client); }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                console.log(`[MapServer] /mapdata parse error: ${e.message}`);
                res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url === '/navigate' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { x, y, accountId } = JSON.parse(body);
                // Replace any existing navigate command (only latest target matters)
                commandQueue = commandQueue.filter(c => c.action !== 'navigate');
                const cmd = { action: 'navigate', x, y };
                commandQueue.push(cmd);
                console.log(`[MapServer] Navigate target set: (${x}, ${y}) (queue: ${commandQueue.length})`);
                // Push to bot for immediate processing (skip 2s poll latency)
                _sendToBots('navigate', cmd, accountId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url === '/navigate' && req.method === 'DELETE') {
        commandQueue = commandQueue.filter(c => c.action !== 'navigate');
        // Also clear any active patrol route on the bot
        _sendToBots('navigate', { action: 'stop' });
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    if (req.url === '/death' && req.method === 'POST') {
        commandQueue.push({ action: 'death' });
        console.log(`[MapServer] Death command queued (queue: ${commandQueue.length})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    if (req.url === '/title' && req.method === 'POST') {
        commandQueue.push({ action: 'title' });
        console.log(`[MapServer] Title command queued (queue: ${commandQueue.length})`);
        _sendToBots('command', { action: 'title' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    if (req.url === '/spawn' && req.method === 'POST') {
        commandQueue.push({ action: 'spawn' });
        console.log(`[MapServer] Spawn command queued (queue: ${commandQueue.length})`);
        _sendToBots('command', { action: 'spawn' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    if (req.url === '/equip' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const cmd = { action: 'equip', buildFile: data.buildFile || 'loadouts/move.txt', buildCode: data.buildCode || null, talents: data.talents || null };
                const accountId = data.accountId || null;
                commandQueue.push(cmd);
                console.log(`[MapServer] Equip command queued (queue: ${commandQueue.length}, target: ${accountId || 'all'})`);
                _sendToBots('equip', cmd, accountId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url === '/attack/toggle' && req.method === 'POST') {
        attackToggled = !attackToggled;
        console.log(`[MapServer] Attack toggled: ${attackToggled ? 'ON' : 'OFF'}`);
        _sendToBots('state', { attack: attackToggled, defend: defendToggled });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, active: attackToggled }));
        return;
    }

    if (req.url === '/daily-claim' && req.method === 'POST') {
        console.log(`[MapServer] Daily claim requested`);
        _sendToBots('daily-claim', {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    if (req.url === '/switch' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 256) req.destroy(); });
        req.on('end', () => {
            try {
                const { region, biome } = JSON.parse(body || '{}');
                if (!region || !biome) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'region and biome required' }));
                    return;
                }
                // Immediately clear stale viewer state so any concurrent
                // /mapdata safety poll or freshly-connected SSE client
                // cannot replay mobs/map from the previous server.
                latestData.mobs = null;
                latestData.map = null;
                latestData.position = null;
                // Notify all SSE subscribers so they can wipe their local
                // state too (defense in depth — switchServer() on the
                // viewer also does this immediately, but a second viewer
                // opened in another tab gets the SSE notification).
                const switchEvt = { type: 'switch', region, biome };
                const cSnapshot = clients.slice();
                for (const client of cSnapshot) {
                    try { client.write(`data: ${JSON.stringify(switchEvt)}\n\n`); } catch (e) { /* ignore */ }
                }
                // Append to commandQueue; bot_client_2 polls it (or we can
                // push via SSE, but the bot doesn't subscribe to anything
                // other than UDP discovery). Use commandQueue + bot poll.
                commandQueue.push({ type: 'switch', region, biome });
                console.log(`[MapServer] Queued switch: ${region}/${biome} (queue=${commandQueue.length})`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, queued: true, region, biome }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    if (req.url === '/defend/toggle' && req.method === 'POST') {
        defendToggled = !defendToggled;
        console.log(`[MapServer] Defend toggled: ${defendToggled ? 'ON' : 'OFF'}`);
        _sendToBots('state', { attack: attackToggled, defend: defendToggled });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, active: defendToggled }));
        return;
    }

    if (req.url === '/state' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ attack: attackToggled, defend: defendToggled }));
        return;
    }

    if (req.url === '/tracking/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(trackingConfig));
        return;
    }

    if (req.url === '/tracking/config' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (data.targets && Array.isArray(data.targets)) {
                    trackingConfig.targets = data.targets;
                }
                saveTrackingConfig();
                pushTrackingConfigToBot();
                console.log(`[MapServer] Tracking config updated: ${trackingConfig.targets.length} targets`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url === '/routes' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(customRoutes));
        return;
    }

    if (req.url === '/routes' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (data.key && Array.isArray(data.waypoints)) {
                    customRoutes[data.key] = data.waypoints;
                    saveRoutes();
                    console.log(`[MapServer] Route saved: ${data.key} (${data.waypoints.length} waypoints)`);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url.startsWith('/routes/') && req.method === 'DELETE') {
        const key = decodeURIComponent(req.url.slice('/routes/'.length));
        delete customRoutes[key];
        saveRoutes();
        console.log(`[MapServer] Route deleted: ${key}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    if (req.url === '/command' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (commandQueue.length > 0) {
            res.end(JSON.stringify(commandQueue.shift()));
        } else {
            res.end(JSON.stringify({ action: 'none' }));
        }
        return;
    }

    if (req.url === '/command' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const cmd = JSON.parse(body);
                const accountId = cmd.accountId;
                if (cmd.action === 'patrol') {
                    _sendToBots('patrol', cmd, accountId);
                    console.log(`[MapServer] Patrol command sent: ${cmd.route?.length || 0} waypoints`);
                } else if (cmd.action === 'title' || cmd.action === 'spawn' || cmd.action === 'death') {
                    _sendToBots('command', cmd, accountId);
                    console.log(`[MapServer] ${cmd.action} command sent`);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url === '/ack' && req.method === 'POST') {
        commandQueue.shift();
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, remaining: commandQueue.length }));
        return;
    }

    // ━━━━━━ Auto Patrol Endpoints ━━━━━━
    if (req.url === '/auto-patrol/servers' && req.method === 'GET') {
        // Full region × biome list (same as the dropdown).
        // Route matching happens after the bot connects and receives
        // biomeName/mapName from the game server.
        const regions = (gameConfig && gameConfig.regions) || [];
        const biomes = (gameConfig && gameConfig.biomes) || [];
        const servers = [];
        for (const biome of biomes) {
            for (const region of regions) {
                servers.push({
                    region: region.slug,
                    biome: biome.slug,
                });
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(servers));
        return;
    }

    if (req.url === '/auto-patrol/start' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const servers = data.servers || [];
                const accountId = data.accountId;
                const targets = accountId ? [[accountId, botSessions.get(accountId)]] : Array.from(botSessions.entries());
                const sentIds = [];
                const failIds = [];
                if (!accountId && targets.length > 1) {
                    for (let i = 0; i < targets.length; i++) {
                        const [id, session] = targets[i];
                        const distributed = servers.filter((_, idx) => idx % targets.length === i);
                        if (session?.client) {
                            try {
                                const msg = `event: auto-patrol\ndata: ${JSON.stringify({ action: 'start', servers: distributed })}\n\n`;
                                session.client.write(msg);
                                sentIds.push(id.slice(0,8) + `(${distributed.length})`);
                            } catch(e) { failIds.push(id.slice(0,8) + ':' + e.message); }
                        } else { failIds.push(id.slice(0,8) + ':no-client'); }
                    }
                } else {
                    for (const [id, session] of targets) {
                        if (session?.client) {
                            try {
                                const msg = `event: auto-patrol\ndata: ${JSON.stringify({ action: 'start', servers })}\n\n`;
                                session.client.write(msg);
                                sentIds.push(id.slice(0,8) + `(${servers.length})`);
                            } catch(e) { failIds.push(id.slice(0,8) + ':' + e.message); }
                        } else { failIds.push(id.slice(0,8) + ':no-client'); }
                    }
                }
                console.log(`[MapServer] Auto-patrol START: ${servers.length} servers → sent=${sentIds.length} [${sentIds.join(', ')}] fail=${failIds.length}${failIds.length ? ' [' + failIds.join(',') + ']' : ''}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
        });
        return;
    }

    if (req.url === '/auto-patrol/stop' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const accountId = data.accountId;
                const targets = accountId ? [botSessions.get(accountId)] : Array.from(botSessions.values());
                for (const session of targets) {
                    if (session?.client) {
                        try { session.client.write(`event: auto-patrol\ndata: ${JSON.stringify({ action: 'stop' })}\n\n`); } catch(e) {}
                    }
                }
                console.log(`[MapServer] Auto-patrol STOP sent to ${targets.length} bot(s)`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
        });
        return;
    }

    if (req.url === '/auto-patrol/status' && req.method === 'GET') {
        const statuses = {};
        for (const [id, session] of botSessions) {
            statuses[id] = session.latestData['auto-patrol'] || { active: false, state: 'idle', pinkyFailCount: 0, currentServer: null, serverIndex: 0, serverCount: 0, log: [] };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(statuses));
        return;
    }

    // ━━━━━━ Multi-bot Account Endpoints ━━━━━━
    if (req.url === '/accounts' && req.method === 'GET') {
        const accounts = [];
        for (const [id, session] of botSessions) {
            const status = session.latestData['auto-patrol'] || {};
            const map = session.latestData.map || {};
            accounts.push({
                accountId: id,
                username: session.username || '',
                connected: true,
                biomeName: map.biomeName || '',
                mapName: map.mapName || '',
                region: map.region || '',
                state: status.state || 'idle',
                active: status.active || false,
                serverIndex: status.serverIndex || 0,
                serverCount: status.serverCount || 0,
                pinkyFailCount: status.pinkyFailCount || 0,
                log: (status.log || []).slice(-5),
            });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accounts }));
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

server.listen(PORT, () => {
    console.log(`\x1b[36m[MapServer] Map viewer: http://localhost:${PORT}\x1b[0m`);
    startControlDiscovery();
});
