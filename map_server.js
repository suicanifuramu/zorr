import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import dgram from "node:dgram";
import { getOrComputeExtraction, invalidateCache } from "./extraction_pipeline.js";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env for DISCORD_WEBHOOK_URL
try {
    dotenv.config({ path: path.join(__dirname, ".env") });
} catch (e) {
    /* dotenv not available, ignore */
}

const PORT = 3000;
const CONTROL_DISCOVERY_PORT = 41235; // UDP port for "I'm here" broadcast to bot
let latestData = { config: null }; // Global: only config is shared
let clients = [];
const commandQueues = new Map(); // Map<accountId, Array<{action,...}>>
const accountStates = new Map(); // Map<accountId, {attack, defend}>
let gameConfig = null;
let lastExtractionError = null;
// Multi-bot: Map<accountId, { client, latestData }>
const botSessions = new Map();
let controlDiscoverySocket = null; // UDP socket for broadcasting presence to bot
let controlDiscoveryInterval = null; // 3s heartbeat interval
const _loggedTypes = new Set(); // dedupe: log first /mapdata per type, then silent
let _loggedDeadClient = false; // dedupe: log first dead SSE client, then silent

// Routes storage
const ROUTES_PATH = path.join(__dirname, "routes.json");
let customRoutes = {};
try {
    if (fs.existsSync(ROUTES_PATH)) {
        const raw = fs.readFileSync(ROUTES_PATH, "utf8").replace(/^\uFEFF/, "");
        customRoutes = JSON.parse(raw);
        console.log(`[MapServer] Loaded ${Object.keys(customRoutes).length} routes`);
    }
} catch (e) {
    /* ignore */
}

function saveRoutes() {
    try {
        fs.writeFileSync(ROUTES_PATH, JSON.stringify(customRoutes, null, 2));
    } catch (e) {
        /* ignore */
    }
}

// Tracking config (targets + webhook URL)
const TRACKING_CONFIG_PATH = path.join(__dirname, "tracking_config.json");
let trackingConfig = { targets: [] };
try {
    if (fs.existsSync(TRACKING_CONFIG_PATH)) {
        const rawCfg = fs.readFileSync(TRACKING_CONFIG_PATH, "utf8").replace(/^\uFEFF/, "");
        trackingConfig = JSON.parse(rawCfg);
        console.log(`[MapServer] Loaded tracking config: ${trackingConfig.targets.length} targets`);
    }
} catch (e) {
    /* ignore parse errors */
}

function saveTrackingConfig() {
    try {
        fs.writeFileSync(TRACKING_CONFIG_PATH, JSON.stringify(trackingConfig, null, 2));
    } catch (e) {
        /* ignore write errors */
    }
}

function pushTrackingConfigToBot() {
    const payload = { ...trackingConfig };
    for (const [id, session] of botSessions) {
        if (session?.client) {
            try {
                session.client.write(`event: tracking\ndata: ${JSON.stringify(payload)}\n\n`);
            } catch (e) {}
        }
    }
}

// Ping rules (role pings per mob condition)
const PING_RULES_PATH = path.join(__dirname, "ping_rules.json");
let pingRules = { rules: [] };
try {
    if (fs.existsSync(PING_RULES_PATH)) {
        const rawPr = fs.readFileSync(PING_RULES_PATH, "utf8").replace(/^\uFEFF/, "");
        pingRules = JSON.parse(rawPr);
        console.log(`[MapServer] Loaded ping rules: ${pingRules.rules.length} rules`);
    }
} catch (e) {
    /* ignore parse errors */
}

function savePingRules() {
    try {
        fs.writeFileSync(PING_RULES_PATH, JSON.stringify(pingRules, null, 2));
    } catch (e) {
        /* ignore write errors */
    }
}

function pushPingRulesToBot() {
    for (const [id, session] of botSessions) {
        if (session?.client) {
            try {
                session.client.write(`event: ping-rules\ndata: ${JSON.stringify(pingRules)}\n\n`);
            } catch (e) {}
        }
    }
}

// Biome channel config (channel ID per biome for Discord Bot API)
const BIOME_CHANNELS_PATH = path.join(__dirname, "biome_channels.json");
let biomeChannels = { defaultChannelId: "", biomes: {} };
try {
    if (fs.existsSync(BIOME_CHANNELS_PATH)) {
        const rawBc = fs.readFileSync(BIOME_CHANNELS_PATH, "utf8").replace(/^\uFEFF/, "");
        biomeChannels = JSON.parse(rawBc);
        console.log(`[MapServer] Loaded biome channels: ${Object.keys(biomeChannels.biomes).length} biomes`);
    }
} catch (e) {
    /* ignore parse errors */
}

function saveBiomeChannels() {
    try {
        fs.writeFileSync(BIOME_CHANNELS_PATH, JSON.stringify(biomeChannels, null, 2));
    } catch (e) {
        /* ignore write errors */
    }
}

function pushBiomeChannelsToBot() {
    for (const [id, session] of botSessions) {
        if (session?.client) {
            try {
                session.client.write(`event: biome-channels\ndata: ${JSON.stringify(biomeChannels)}\n\n`);
            } catch (e) {}
        }
    }
}

// Helper: send event to all bots, or a specific bot if accountId is provided
function _sendToBots(eventType, data, accountId) {
    const msg = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    if (accountId) {
        const session = botSessions.get(accountId);
        if (session?.client) {
            try {
                session.client.write(msg);
            } catch (e) {}
        }
    } else {
        for (const [id, session] of botSessions) {
            if (session?.client) {
                try {
                    session.client.write(msg);
                } catch (e) {}
            }
        }
    }
}

// Broadcast "I'm here" over UDP so bot clients can detect map_server startup
// without having to poll. Bot listens on CONTROL_DISCOVERY_PORT and opens the
// SSE connection when it receives a hello.
function startControlDiscovery() {
    try {
        controlDiscoverySocket = dgram.createSocket("udp4");
        controlDiscoverySocket.on("error", (e) => {
            console.log(`\x1b[33m[MapServer] Control discovery socket error: ${e.message}\x1b[0m`);
        });
        controlDiscoverySocket.bind(0, "127.0.0.1", () => {
            const msg = Buffer.from(
                JSON.stringify({
                    type: "zorr-control-hello",
                    url: `http://localhost:${PORT}`,
                    pid: process.pid,
                    ts: Date.now(),
                })
            );
            const send = () => {
                if (!controlDiscoverySocket) return;
                try {
                    controlDiscoverySocket.send(msg, CONTROL_DISCOVERY_PORT, "127.0.0.1");
                } catch (e) {
                    /* ignore send errors */
                }
            };
            send();
            controlDiscoveryInterval = setInterval(send, 3000);
            controlDiscoveryInterval.unref();
            console.log(
                `\x1b[36m[MapServer] Broadcasting control discovery on UDP 127.0.0.1:${CONTROL_DISCOVERY_PORT} (every 3s)\x1b[0m`
            );
        });
    } catch (e) {
        console.log(`\x1b[33m[MapServer] Failed to start control discovery: ${e.message}\x1b[0m`);
    }
}

// Always extract fresh from zorr.pages.dev at startup.
// Uses the unified pipeline (shared with game_data_extractor).
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
        latestData.config = { type: "config", ...gameConfig };
        console.log(
            `\x1b[32m[MapServer] Game config loaded: ${gameConfig.petals.length} petals, ${gameConfig.mobs.length} mobs, ${gameConfig.talents.length} talents, ${gameConfig.variants.length} variants, ${gameConfig.rarities.length} rarities, ${gameConfig.regions.length} regions, ${gameConfig.biomes.length} biomes, protocol=${gameConfig.protocolVersion} (${gameConfig.vmRunMs}ms VM, ${gameConfig.snakeMobIndices.length} snakes via ${gameConfig.snakeMethod})\x1b[0m`
        );
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
        console.error(
            `\x1b[31m[MapServer] WARNING: Server starting without game config. /config will return 503.\x1b[0m`
        );
    }
});

const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.url === "/" && req.method === "GET") {
        const htmlPath = path.join(__dirname, "map.html");
        if (fs.existsSync(htmlPath)) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            fs.createReadStream(htmlPath).pipe(res);
        } else {
            res.writeHead(404);
            res.end("map.html not found");
        }
        return;
    }

    if (req.url === "/config" && req.method === "GET") {
        res.setHeader("Cache-Control", "no-store");
        if (gameConfig) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(gameConfig));
        } else {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: lastExtractionError || "Game config not yet loaded" }));
        }
        return;
    }

    if (req.url === "/config/refresh" && req.method === "POST") {
        res.setHeader("Content-Type", "application/json");
        invalidateCache();
        refreshConfig().then((c) => {
            if (c) {
                res.end(
                    JSON.stringify({
                        ok: true,
                        schemaVersion: c.schemaVersion,
                        vmRunMs: c.vmRunMs,
                        snakeMethod: c.snakeMethod,
                    })
                );
            } else {
                res.writeHead(500);
                res.end(JSON.stringify({ error: lastExtractionError || "unknown" }));
            }
        });
        return;
    }

    if (req.url === "/events" && req.method === "GET") {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });

        clients.push(res);
        console.log(`[MapServer] Client connected (${clients.length} total)`);

        if (latestData.config) res.write(`data: ${JSON.stringify(latestData.config)}\n\n`);
        for (const [id, session] of botSessions) {
            for (const type of ["map", "position", "mobs", "daily-streak", "auto-patrol"]) {
                if (session.latestData[type]) {
                    try {
                        res.write(`data: ${JSON.stringify({ ...session.latestData[type], accountId: id })}\n\n`);
                    } catch (e) {}
                }
            }
        }

        req.on("close", () => {
            clients = clients.filter((c) => c !== res);
        });
        return;
    }

    if (req.url.startsWith("/control-stream") && req.method === "GET") {
        // Parse accountId from query string
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const accountId = parsedUrl.searchParams.get("accountId") || "default";

        // Close previous connection for same accountId
        const existing = botSessions.get(accountId);
        if (existing) {
            try {
                existing.client.end();
            } catch (e) {}
        }

        // Preserve existing latestData across reconnections (don't null out data accumulated from /mapdata POSTs)
        const existingLatest = existing?.latestData || {};
        const sessionData = {
            client: res,
            latestData: {
                map: existingLatest.map || null,
                position: existingLatest.position || null,
                mobs: existingLatest.mobs || null,
                config: existingLatest.config || null,
                "daily-streak": existingLatest["daily-streak"] || null,
                "auto-patrol": existingLatest["auto-patrol"] || null,
            },
        };
        botSessions.set(accountId, sessionData);

        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
        // Initial state push (per-account)
        const acctState = accountStates.get(accountId) || { attack: false, defend: false };
        res.write(`event: state\ndata: ${JSON.stringify({ attack: acctState.attack, defend: acctState.defend })}\n\n`);
        if (trackingConfig.targets.length > 0) {
            res.write(`event: tracking\ndata: ${JSON.stringify({ ...trackingConfig })}\n\n`);
        }
        res.write(`event: ping-rules\ndata: ${JSON.stringify(pingRules)}\n\n`);
        res.write(`event: biome-channels\ndata: ${JSON.stringify(biomeChannels)}\n\n`);
        console.log(`[MapServer] Bot connected: ${accountId.slice(0, 8)}`);

        req.on("close", () => {
            if (botSessions.get(accountId)?.client === res) {
                botSessions.delete(accountId);
                // Clear this account's data from all viewers
                const snapshot = clients.slice();
                for (const client of snapshot) {
                    try {
                        client.write(`data: ${JSON.stringify({ type: "account-disconnect", accountId })}\n\n`);
                    } catch (e) {
                        try {
                            client.end();
                        } catch (_) {}
                        clients = clients.filter((c) => c !== client);
                    }
                }
            }
            console.log(`[MapServer] Bot disconnected: ${accountId.slice(0, 8)}`);
        });
        return;
    }

    if (req.url === "/mapdata" && req.method === "GET") {
        // Return all accounts' cached data as a single snapshot.
        const allData = {};
        for (const [id, session] of botSessions) {
            allData[id] = session.latestData;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(allData));
        return;
    }

    if (req.url === "/mapdata" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            try {
                const data = JSON.parse(body);
                const accountId = data.accountId || "default";
                let session = botSessions.get(accountId);
                if (!session) {
                    // Create ephemeral session so data is still tracked per-account
                    session = {
                        client: null,
                        latestData: {
                            map: null,
                            position: null,
                            mobs: null,
                            config: null,
                            "daily-streak": null,
                            "auto-patrol": null,
                        },
                        username: "",
                    };
                    botSessions.set(accountId, session);
                    if (!_loggedTypes.has("no-session-" + accountId)) {
                        _loggedTypes.add("no-session-" + accountId);
                        console.log(`[MapServer] No session for ${accountId.slice(0, 8)}, created ephemeral session`);
                    }
                }
                session.latestData[data.type] = data;
                if (data.type === "despawn") session.latestData.position = null;
                if (data.type === "switch") {
                    session.latestData.mobs = null;
                    session.latestData.map = null;
                    session.latestData.position = null;
                }
                if (data.username) session.username = data.username;

                // Broadcast to all viewers with accountId
                const broadcastData = { ...data, accountId };
                const snapshot = clients.slice();
                for (const client of snapshot) {
                    try {
                        client.write(`data: ${JSON.stringify(broadcastData)}\n\n`);
                    } catch (e) {
                        try {
                            client.end();
                        } catch (_) {}
                        clients = clients.filter((c) => c !== client);
                    }
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                console.log(`[MapServer] /mapdata parse error: ${e.message}`);
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url === "/navigate" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            try {
                const { x, y, accountId } = JSON.parse(body);
                const cmd = { action: "navigate", x, y };
                // Push to bot for immediate processing (skip 2s poll latency)
                _sendToBots("navigate", cmd, accountId);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url === "/navigate" && req.method === "DELETE") {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const accountId = parsedUrl.searchParams.get("accountId");
        if (accountId) {
            const q = commandQueues.get(accountId);
            if (q) {
                const idx = q.findIndex((c) => c.action === "navigate");
                if (idx >= 0) q.splice(idx, 1);
            }
            _sendToBots("navigate", { action: "stop" }, accountId);
        } else {
            for (const [, q] of commandQueues) {
                const idx = q.findIndex((c) => c.action === "navigate");
                if (idx >= 0) q.splice(idx, 1);
            }
            _sendToBots("navigate", { action: "stop" });
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    if (req.url === "/death" && req.method === "POST") {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const accountId = parsedUrl.searchParams.get("accountId") || "default";
        const q = commandQueues.get(accountId) || [];
        if (!commandQueues.has(accountId)) commandQueues.set(accountId, q);
        q.push({ action: "death" });
        console.log(`[MapServer] Death command queued for ${accountId.slice(0, 8)} (queue: ${q.length})`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    if (req.url === "/title" && req.method === "POST") {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const accountId = parsedUrl.searchParams.get("accountId") || "default";
        const q = commandQueues.get(accountId) || [];
        if (!commandQueues.has(accountId)) commandQueues.set(accountId, q);
        q.push({ action: "title" });
        console.log(`[MapServer] Title command queued for ${accountId.slice(0, 8)} (queue: ${q.length})`);
        _sendToBots("command", { action: "title" }, accountId !== "default" ? accountId : null);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    if (req.url === "/spawn" && req.method === "POST") {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const accountId = parsedUrl.searchParams.get("accountId") || "default";
        const q = commandQueues.get(accountId) || [];
        if (!commandQueues.has(accountId)) commandQueues.set(accountId, q);
        q.push({ action: "spawn" });
        console.log(`[MapServer] Spawn command queued for ${accountId.slice(0, 8)} (queue: ${q.length})`);
        _sendToBots("command", { action: "spawn" }, accountId !== "default" ? accountId : null);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    if (req.url === "/equip" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            try {
                const data = JSON.parse(body);
                const cmd = {
                    action: "equip",
                    buildFile: data.buildFile || "loadouts/move.txt",
                    buildCode: data.buildCode || null,
                    talents: data.talents || null,
                };
                const accountId = data.accountId || null;
                if (accountId) {
                    const q = commandQueues.get(accountId) || [];
                    if (!commandQueues.has(accountId)) commandQueues.set(accountId, q);
                    q.push(cmd);
                }
                console.log(`[MapServer] Equip command queued (target: ${accountId || "all"})`);
                _sendToBots("equip", cmd, accountId);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url === "/attack/toggle" && req.method === "POST") {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const accountId = parsedUrl.searchParams.get("accountId");
        if (accountId) {
            const st = accountStates.get(accountId) || { attack: false, defend: false };
            st.attack = !st.attack;
            accountStates.set(accountId, st);
            console.log(`[MapServer] Attack toggled for ${accountId.slice(0, 8)}: ${st.attack ? "ON" : "OFF"}`);
            _sendToBots("state", { attack: st.attack, defend: st.defend }, accountId);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, active: st.attack }));
        } else {
            // Fallback: toggle all
            for (const [id] of botSessions) {
                const st = accountStates.get(id) || { attack: false, defend: false };
                st.attack = !st.attack;
                accountStates.set(id, st);
            }
            const anyState = accountStates.values().next().value || { attack: false };
            console.log(`[MapServer] Attack toggled (all): ${anyState.attack ? "ON" : "OFF"}`);
            _sendToBots("state", { attack: anyState.attack, defend: anyState.defend });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, active: anyState.attack }));
        }
        return;
    }

    if (req.url === "/daily-claim" && req.method === "POST") {
        console.log(`[MapServer] Daily claim requested`);
        _sendToBots("daily-claim", {});
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    if (req.url === "/switch" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => {
            body += c;
            if (body.length > 256) req.destroy();
        });
        req.on("end", () => {
            try {
                const { region, biome, accountId } = JSON.parse(body || "{}");
                if (!region || !biome) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: "region and biome required" }));
                    return;
                }
                // Clear only the specified account's data
                const targetId = accountId || "default";
                const session = botSessions.get(targetId);
                if (session) {
                    session.latestData.mobs = null;
                    session.latestData.map = null;
                    session.latestData.position = null;
                    session.latestData["auto-patrol"] = null;
                }
                // Notify all SSE subscribers with accountId
                const switchEvt = { type: "switch", region, biome, accountId: targetId };
                const cSnapshot = clients.slice();
                for (const client of cSnapshot) {
                    try {
                        client.write(`data: ${JSON.stringify(switchEvt)}\n\n`);
                    } catch (e) {
                        /* ignore */
                    }
                }
                _sendToBots("command", { type: "switch", region, biome }, accountId);
                console.log(`[MapServer] Queued switch: ${region}/${biome} for ${targetId.slice(0, 8)}`);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, queued: true, region, biome }));
            } catch (e) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    if (req.url === "/defend/toggle" && req.method === "POST") {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const accountId = parsedUrl.searchParams.get("accountId");
        if (accountId) {
            const st = accountStates.get(accountId) || { attack: false, defend: false };
            st.defend = !st.defend;
            accountStates.set(accountId, st);
            console.log(`[MapServer] Defend toggled for ${accountId.slice(0, 8)}: ${st.defend ? "ON" : "OFF"}`);
            _sendToBots("state", { attack: st.attack, defend: st.defend }, accountId);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, active: st.defend }));
        } else {
            for (const [id] of botSessions) {
                const st = accountStates.get(id) || { attack: false, defend: false };
                st.defend = !st.defend;
                accountStates.set(id, st);
            }
            const anyState = accountStates.values().next().value || { defend: false };
            console.log(`[MapServer] Defend toggled (all): ${anyState.defend ? "ON" : "OFF"}`);
            _sendToBots("state", { attack: anyState.attack, defend: anyState.defend });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, active: anyState.defend }));
        }
        return;
    }

    if (req.url.startsWith("/state") && req.method === "GET") {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const accountId = parsedUrl.searchParams.get("accountId");
        if (accountId) {
            const st = accountStates.get(accountId) || { attack: false, defend: false };
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ attack: st.attack, defend: st.defend }));
        } else {
            // Return first account's state or defaults
            const anyState = accountStates.values().next().value || { attack: false, defend: false };
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ attack: anyState.attack, defend: anyState.defend }));
        }
        return;
    }

    if (req.url === "/tracking/config" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(trackingConfig));
        return;
    }

    if (req.url === "/tracking/config" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            try {
                const data = JSON.parse(body);
                if (data.targets && Array.isArray(data.targets)) {
                    trackingConfig.targets = data.targets;
                }
                saveTrackingConfig();
                pushTrackingConfigToBot();
                console.log(`[MapServer] Tracking config updated: ${trackingConfig.targets.length} targets`);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url === "/routes" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(customRoutes));
        return;
    }

    if (req.url === "/routes" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            try {
                const data = JSON.parse(body);
                if (data.key && Array.isArray(data.waypoints)) {
                    customRoutes[data.key] = data.waypoints;
                    saveRoutes();
                    console.log(`[MapServer] Route saved: ${data.key} (${data.waypoints.length} waypoints)`);
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url.startsWith("/routes/") && req.method === "DELETE") {
        const key = decodeURIComponent(req.url.slice("/routes/".length));
        delete customRoutes[key];
        saveRoutes();
        console.log(`[MapServer] Route deleted: ${key}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    if (req.url.startsWith("/command") && req.method === "GET") {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const accountId = parsedUrl.searchParams.get("accountId");
        res.writeHead(200, { "Content-Type": "application/json" });
        if (accountId) {
            const q = commandQueues.get(accountId);
            if (q && q.length > 0) {
                res.end(JSON.stringify(q.shift()));
            } else {
                res.end(JSON.stringify({ action: "none" }));
            }
        } else {
            // Legacy fallback: return from any queue
            for (const [, q] of commandQueues) {
                if (q.length > 0) {
                    res.end(JSON.stringify(q.shift()));
                    return;
                }
            }
            res.end(JSON.stringify({ action: "none" }));
        }
        return;
    }

    if (req.url === "/command" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            try {
                const cmd = JSON.parse(body);
                const accountId = cmd.accountId;
                if (cmd.action === "patrol") {
                    _sendToBots("patrol", cmd, accountId);
                    console.log(`[MapServer] Patrol command sent: ${cmd.route?.length || 0} waypoints`);
                } else if (cmd.action === "title" || cmd.action === "spawn" || cmd.action === "death") {
                    _sendToBots("command", cmd, accountId);
                    console.log(`[MapServer] ${cmd.action} command sent`);
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url === "/ack" && req.method === "POST") {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const accountId = parsedUrl.searchParams.get("accountId");
        let remaining = 0;
        if (accountId) {
            const q = commandQueues.get(accountId);
            if (q && q.length > 0) q.shift();
            remaining = q ? q.length : 0;
        } else {
            for (const [, q] of commandQueues) {
                if (q.length > 0) {
                    q.shift();
                    break;
                }
            }
            for (const [, q] of commandQueues) remaining += q.length;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, remaining }));
        return;
    }

    // ━━━━━━ Auto Patrol Endpoints ━━━━━━
    if (req.url === "/auto-patrol/servers" && req.method === "GET") {
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(servers));
        return;
    }

    if (req.url === "/auto-patrol/start" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            try {
                const data = JSON.parse(body || "{}");
                const servers = data.servers || [];
                const accountId = data.accountId;
                const targets = accountId
                    ? [[accountId, botSessions.get(accountId)]]
                    : Array.from(botSessions.entries());
                const sentIds = [];
                const failIds = [];
                if (!accountId && targets.length > 1) {
                    for (let i = 0; i < targets.length; i++) {
                        const [id, session] = targets[i];
                        const distributed = servers.filter((_, idx) => idx % targets.length === i);
                        if (session?.client) {
                            try {
                                const msg = `event: auto-patrol\ndata: ${JSON.stringify({ action: "start", servers: distributed })}\n\n`;
                                session.client.write(msg);
                                sentIds.push(id.slice(0, 8) + `(${distributed.length})`);
                            } catch (e) {
                                failIds.push(id.slice(0, 8) + ":" + e.message);
                            }
                        } else {
                            failIds.push(id.slice(0, 8) + ":no-client");
                        }
                    }
                } else {
                    for (const [id, session] of targets) {
                        if (session?.client) {
                            try {
                                const msg = `event: auto-patrol\ndata: ${JSON.stringify({ action: "start", servers })}\n\n`;
                                session.client.write(msg);
                                sentIds.push(id.slice(0, 8) + `(${servers.length})`);
                            } catch (e) {
                                failIds.push(id.slice(0, 8) + ":" + e.message);
                            }
                        } else {
                            failIds.push(id.slice(0, 8) + ":no-client");
                        }
                    }
                }
                console.log(
                    `[MapServer] Auto-patrol START: ${servers.length} servers → sent=${sentIds.length} [${sentIds.join(", ")}] fail=${failIds.length}${failIds.length ? " [" + failIds.join(",") + "]" : ""}`
                );
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url === "/auto-patrol/stop" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            try {
                const data = JSON.parse(body || "{}");
                const accountId = data.accountId;
                const targets = accountId ? [botSessions.get(accountId)] : Array.from(botSessions.values());
                for (const session of targets) {
                    if (session?.client) {
                        try {
                            session.client.write(`event: auto-patrol\ndata: ${JSON.stringify({ action: "stop" })}\n\n`);
                        } catch (e) {}
                    }
                }
                console.log(`[MapServer] Auto-patrol STOP sent to ${targets.length} bot(s)`);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url === "/auto-patrol/status" && req.method === "GET") {
        const statuses = {};
        for (const [id, session] of botSessions) {
            statuses[id] = session.latestData["auto-patrol"] || {
                active: false,
                state: "idle",
                pinkyFailCount: 0,
                currentServer: null,
                serverIndex: 0,
                serverCount: 0,
                log: [],
            };
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(statuses));
        return;
    }

    // ━━━━━━ Multi-bot Account Endpoints ━━━━━━
    if (req.url === "/accounts" && req.method === "GET") {
        const accounts = [];
        for (const [id, session] of botSessions) {
            const status = session.latestData["auto-patrol"] || {};
            const map = session.latestData.map || {};
            const position = session.latestData.position || {};
            accounts.push({
                accountId: id,
                username: session.username || "",
                connected: true,
                biomeName: map.biomeName || "",
                mapName: map.mapName || "",
                region: map.region || "",
                serverUrl: position.serverUrl || map.serverUrl || status.serverUrl || "",
                lastWsMessageAt: position.lastWsMessageAt || map.lastWsMessageAt || status.lastWsMessageAt || 0,
                lastMapAt: map.botTs || 0,
                lastPositionAt: position.botTs || 0,
                wsStaleMs:
                    position.lastWsMessageAt || map.lastWsMessageAt || status.lastWsMessageAt
                        ? Date.now() - (position.lastWsMessageAt || map.lastWsMessageAt || status.lastWsMessageAt)
                        : null,
                mapStaleMs: map.botTs ? Date.now() - map.botTs : null,
                positionStaleMs: position.botTs ? Date.now() - position.botTs : null,
                navRouteIndex: position.navRouteIndex ?? status.navRouteIndex ?? 0,
                navRouteCount: position.navRouteCount ?? status.navRouteCount ?? 0,
                navWaypointIndex: position.navWaypointIndex ?? status.navWaypointIndex ?? 0,
                navigateTarget: position.navigateTarget || status.navigateTarget || null,
                state: status.state || "idle",
                active: status.active || false,
                serverIndex: status.serverIndex || 0,
                serverCount: status.serverCount || 0,
                pinkyFailCount: status.pinkyFailCount || 0,
                log: (status.log || []).slice(-5),
            });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accounts }));
        return;
    }

    // ━━━━━━ Biome Channels Endpoints ━━━━━━
    if (req.url === "/biome-channels" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(biomeChannels));
        return;
    }

    if (req.url === "/biome-channels" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            try {
                const data = JSON.parse(body);
                if (data.defaultChannelId !== undefined) biomeChannels.defaultChannelId = data.defaultChannelId;
                if (data.biomes && typeof data.biomes === "object") biomeChannels.biomes = data.biomes;
                saveBiomeChannels();
                pushBiomeChannelsToBot();
                console.log(`[MapServer] Biome channels updated: ${Object.keys(biomeChannels.biomes).length} biomes`);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ━━━━━━ Ping Rules Endpoints ━━━━━━
    if (req.url === "/ping-rules" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(pingRules));
        return;
    }

    if (req.url === "/ping-rules" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            try {
                const data = JSON.parse(body);
                if (data.rules && Array.isArray(data.rules)) {
                    pingRules.rules = data.rules.filter((r) => r.roleId);
                }
                savePingRules();
                pushPingRulesToBot();
                console.log(`[MapServer] Ping rules updated: ${pingRules.rules.length} rules`);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ━━━━━━ Roles API Proxy ━━━━━━
    if (req.url === "/api/roles" && req.method === "GET") {
        const guildId = process.env.DISCORD_GUILD_ID;
        const token = process.env.DISCORD_BOT_TOKEN;
        if (!guildId || !token) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "DISCORD_GUILD_ID or DISCORD_BOT_TOKEN not set" }));
            return;
        }
        https
            .get(
                `https://discord.com/api/v10/guilds/${guildId}/roles`,
                {
                    headers: { Authorization: `Bot ${token}` },
                },
                (dRes) => {
                    let body = "";
                    dRes.on("data", (c) => (body += c));
                    dRes.on("end", () => {
                        res.writeHead(dRes.statusCode, {
                            "Content-Type": "application/json",
                            "Access-Control-Allow-Origin": "*",
                        });
                        res.end(body);
                    });
                }
            )
            .on("error", (e) => {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: e.message }));
            });
        return;
    }

    res.writeHead(404);
    res.end("Not found");
});

server.listen(PORT, () => {
    console.log(`\x1b[36m[MapServer] Map viewer: http://localhost:${PORT}\x1b[0m`);
    startControlDiscovery();
});
