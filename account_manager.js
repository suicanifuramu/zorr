const fs = require("fs");
const path = require("path");
const http = require("http");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { BotSession } = require("./bot_session");
const { invalidateCache } = require("./extraction_pipeline");

// ── Shared game data (loaded once, shared across all BotSessions) ──
let gameData = null;

async function loadGameData() {
    console.log("[AccountManager] Loading shared game data...");
    // Always fetch fresh game data so the protocol version matches the live server.
    invalidateCache();
    const { extractGameData } = require("./game_data_extractor");
    gameData = await extractGameData({ includeSource: true });
    if (gameData.schemaVersion !== 2) {
        throw new Error(`Unsupported schema version ${gameData.schemaVersion}`);
    }
    if (!gameData.petals || gameData.petals.length === 0) {
        throw new Error("Failed to parse petal names");
    }
    if (!gameData.mobs || gameData.mobs.length === 0) {
        throw new Error("Failed to parse mob names");
    }
    if (!gameData.rarities || gameData.rarities.length === 0) {
        throw new Error("Failed to parse rarity definitions");
    }

    const petalNames = gameData.petals.map((p) => p.name);
    const slugToId = {};
    for (let i = 0; i < petalNames.length; i++) {
        slugToId[petalNames[i].toLowerCase().replace(/ /g, "_")] = i;
    }
    const mobNames = gameData.mobs.map((m) => m.name);
    const mobSlugs = gameData.mobs.map((m) => m.slug || m.name.toLowerCase().replace(/ /g, "_"));
    const snakeMobIndices = new Set(gameData.snakeMobIndices || []);
    const rarities = gameData.rarities;
    const variants = gameData.variants || [];

    // Pinky detection
    let PINKY_BITMASK = 2048;
    try {
        const srcData = gameData._source;
        if (srcData) {
            const pinkyMatch = srcData.match(
                /\.([a-zA-Z_$][\w$]*)\s*=\s*!!\(\s*(?:2048\s*&\s*[\w$]+|[\w$]+\s*&\s*2048)\s*\)/
            );
            if (pinkyMatch && pinkyMatch[1]) {
                console.log(`[AccountManager] Pinky property: player.${pinkyMatch[1]} (bitmask 2048)`);
            }
        }
    } catch (e) {
        console.log(`[AccountManager] Pinky detection error: ${e.message}`);
    }

    // Protocol version: derive from the same extraction used for game data
    // to avoid stale/mismatched versions between extractGameData and extractProtocolVersion.
    const protocolVersion = gameData.protocolVersion ?? 443;
    console.log(`[AccountManager] Protocol version: ${protocolVersion} (from ${gameData.sourceUrl})`);

    console.log(
        `[AccountManager] Game data loaded: ${petalNames.length} petals, ${mobNames.length} mobs, ${rarities.length} rarities, ${variants.length} variants`
    );

    return {
        petalNames,
        slugToId,
        mobNames,
        mobSlugs,
        snakeMobIndices,
        rarities,
        variants,
        PINKY_BITMASK,
        protocolVersion,
    };
}

// ── Read proxies from file ──
function readProxies(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf8");
    return content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
            const match = line.match(/^(\w+):\/\/([^:]+):(\d+)$/);
            if (!match) return null;
            return { url: line, protocol: match[1], host: match[2], port: parseInt(match[3], 10) };
        })
        .filter((p) => p !== null);
}

// ── Distribute accounts across proxies ──
function distributeAccounts(accounts, proxies) {
    const result = [];
    if (!proxies.length) {
        for (const a of accounts) result.push({ ...a, proxy: null });
        return result;
    }
    const directCount = Math.ceil(accounts.length / (proxies.length + 1));
    let idx = 0;
    for (let i = 0; i < directCount && idx < accounts.length; i++, idx++)
        result.push({ ...accounts[idx], proxy: null });
    const remaining = accounts.length - directCount;
    const perProxy = Math.floor(remaining / proxies.length);
    const extra = remaining % proxies.length;
    for (let p = 0; p < proxies.length; p++) {
        const count = perProxy + (p < extra ? 1 : 0);
        for (let j = 0; j < count; j++, idx++) result.push({ ...accounts[idx], proxy: proxies[p] });
    }
    return result;
}

// ── Read accounts from file ──
function isValidUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function readAccounts(filePath) {
    const content = fs.readFileSync(filePath, "utf8");
    return content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line, idx) => {
            const parts = line.split(":");
            const id = parts[0].trim();
            const buildNumber = parts.length >= 2 && /^\d+$/.test(parts[1]) ? parseInt(parts[1], 10) : null;
            if (!isValidUuid(id)) {
                throw new Error(`accounts.txt line ${idx + 1}: invalid account UUID "${id}"`);
            }
            return { id, buildNumber };
        });
}

// ── Fetch server list from map_server ──
function fetchServerList() {
    return new Promise((resolve, reject) => {
        http.get("http://localhost:3000/auto-patrol/servers", (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(e);
                }
            });
        }).on("error", reject);
    });
}

// ── Distribute servers evenly across accounts ──
function distributeServers(servers, accountCount) {
    const distributions = Array.from({ length: accountCount }, () => []);
    for (let i = 0; i < servers.length; i++) {
        distributions[i % accountCount].push(servers[i]);
    }
    return distributions;
}

// ── Main ──
async function main() {
    console.log("\x1b[1m\x1b[35m═══════════════════════════════════════════════════════");
    console.log("   Zorr Multi-Account Bot Manager");
    console.log("═══════════════════════════════════════════════════════\x1b[0m\n");

    // Load shared game data
    const sharedData = await loadGameData();

    // Read accounts
    const accountsPath = path.join(__dirname, "accounts.txt");
    if (!fs.existsSync(accountsPath)) {
        console.error("\x1b[31m[AccountManager] accounts.txt not found\x1b[0m");
        process.exit(1);
    }
    const accountIds = readAccounts(accountsPath);
    if (accountIds.length === 0) {
        console.error("\x1b[31m[AccountManager] No accounts found in accounts.txt\x1b[0m");
        process.exit(1);
    }
    console.log(`[AccountManager] Found ${accountIds.length} accounts:`);
    accountIds.forEach((entry, i) => {
        const buildTag = entry.buildNumber ? `:${entry.buildNumber}` : "";
        console.log(`  ${i + 1}. ${entry.id}${buildTag}`);
    });

    // Read proxies
    const proxiesPath = path.join(__dirname, "proxies.txt");
    const proxies = readProxies(proxiesPath);
    console.log(`[AccountManager] Found ${proxies.length} proxies`);
    if (proxies.length > 0) {
        proxies.forEach((p, i) => console.log(`  Proxy ${i + 1}: ${p.protocol}://${p.host}:${p.port}`));
    }

    // Distribute accounts across proxies
    const distributed = distributeAccounts(accountIds, proxies);
    console.log(`[AccountManager] Account distribution:`);
    distributed.forEach((entry, i) => {
        const buildTag = entry.buildNumber ? `:${entry.buildNumber}` : "";
        const proxyTag = entry.proxy ? ` via ${entry.proxy.url}` : " (direct)";
        console.log(`  ${i + 1}. ${entry.id}${buildTag}${proxyTag}`);
    });

    // Fetch server list
    let servers;
    try {
        servers = await fetchServerList();
        console.log(`[AccountManager] Server list: ${servers.length} servers`);
    } catch (e) {
        console.error(`[AccountManager] Failed to fetch server list: ${e.message}`);
        console.log("[AccountManager] Falling back to empty server list (manual control only)");
        servers = [];
    }

    // Distribute servers
    const distributions = distributeServers(servers, accountIds.length);
    for (let i = 0; i < accountIds.length; i++) {
        console.log(`[AccountManager] Account ${accountIds[i].id.slice(0, 8)}: ${distributions[i].length} servers`);
    }

    // Create and start BotSessions
    // Stagger initial connections to avoid tripping the server's
    // concurrent-connection / challenge (opcode 0x08) logic.
    const STAGGER_MS = 4000;
    const sessions = [];
    for (let i = 0; i < distributed.length; i++) {
        const entry = distributed[i];
        const accountId = entry.id;
        const proxyUrl = entry.proxy ? entry.proxy.url : null;
        const session = new BotSession(accountId, sharedData, null, entry.buildNumber, proxyUrl);
        sessions.push(session);
        // Start on the first assigned server instead of the hard-coded default.
        if (distributions[i] && distributions[i].length > 0) {
            const first = distributions[i][0];
            session.serverUrl = `wss://s-${first.region}-${first.biome}.zorr.pro/`;
        }
        const buildTag = entry.buildNumber ? ` (build${entry.buildNumber})` : "";
        const proxyTag = entry.proxy ? ` [proxy: ${entry.proxy.url}]` : "";
        setTimeout(() => {
            console.log(`[AccountManager] Starting session for ${accountId.slice(0, 8)}...${buildTag}${proxyTag}`);
            session.start(distributions[i]);
            // Begin auto-patrol immediately using the assigned server distribution.
            if (distributions[i] && distributions[i].length > 0) {
                session.apStart();
            } else {
                console.log(`[AccountManager] No servers assigned to ${accountId.slice(0, 8)}, auto-patrol skipped`);
            }
        }, i * STAGGER_MS);
    }

    // Handle graceful shutdown
    process.on("SIGINT", () => {
        console.log("\n[AccountManager] Shutting down...");
        for (const session of sessions) {
            session.stop();
        }
        process.exit(0);
    });

    console.log(`\x1b[32m[AccountManager] All ${sessions.length} sessions started\x1b[0m`);
}

main().catch((err) => {
    console.error(`\x1b[31m[AccountManager] Fatal: ${err.message}\x1b[0m`);
    process.exit(1);
});
