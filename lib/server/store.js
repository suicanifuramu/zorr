// store.js — persisted server config (routes, tracking, ping rules, biome
// channels) and push-to-bot helpers. Split out of map_server.js.
// `getBots()` is injected to avoid a circular import with map_server.js.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", ".."); // project root
const CONFIG_DIR = path.join(ROOT, "config"); // all persisted config lives here

/** @type {() => Map<string, any>} set by initStore() */
let _getBots = () => new Map();
export function initStore(getBots) {
    _getBots = getBots;
}

// Routes storage
const ROUTES_PATH = path.join(CONFIG_DIR, "routes.json");
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
const TRACKING_CONFIG_PATH = path.join(CONFIG_DIR, "tracking_config.json");
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
    for (const [id, session] of _getBots()) {
        if (session?.client) {
            try {
                session.client.write(`event: tracking\ndata: ${JSON.stringify(payload)}\n\n`);
            } catch (e) {}
        }
    }
}

// Ping rules (role pings per mob condition)
const PING_RULES_PATH = path.join(CONFIG_DIR, "ping_rules.json");
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
    for (const [id, session] of _getBots()) {
        if (session?.client) {
            try {
                session.client.write(`event: ping-rules\ndata: ${JSON.stringify(pingRules)}\n\n`);
            } catch (e) {}
        }
    }
}

// Biome channel config (channel ID per biome for Discord Bot API)
const BIOME_CHANNELS_PATH = path.join(CONFIG_DIR, "biome_channels.json");
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
    for (const [id, session] of _getBots()) {
        if (session?.client) {
            try {
                session.client.write(`event: biome-channels\ndata: ${JSON.stringify(biomeChannels)}\n\n`);
            } catch (e) {}
        }
    }
}

export {
    customRoutes,
    trackingConfig,
    pingRules,
    biomeChannels,
    saveRoutes,
    saveTrackingConfig,
    savePingRules,
    saveBiomeChannels,
    pushTrackingConfigToBot,
    pushPingRulesToBot,
    pushBiomeChannelsToBot,
};
