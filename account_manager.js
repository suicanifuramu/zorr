const fs = require('fs');
const path = require('path');
const http = require('http');
const { BotSession } = require('./bot_session');
const { extractProtocolVersion } = require('./protocol_extractor');

// ── Shared game data (loaded once, shared across all BotSessions) ──
let gameData = null;

async function loadGameData() {
    console.log('[AccountManager] Loading shared game data...');
    const { extractGameData } = require('./game_data_extractor');
    gameData = await extractGameData({ includeSource: true });
    if (gameData.schemaVersion !== 2) {
        throw new Error(`Unsupported schema version ${gameData.schemaVersion}`);
    }
    if (!gameData.petals || gameData.petals.length === 0) {
        throw new Error('Failed to parse petal names');
    }
    if (!gameData.mobs || gameData.mobs.length === 0) {
        throw new Error('Failed to parse mob names');
    }
    if (!gameData.rarities || gameData.rarities.length === 0) {
        throw new Error('Failed to parse rarity definitions');
    }

    const petalNames = gameData.petals.map(p => p.name);
    const slugToId = {};
    for (let i = 0; i < petalNames.length; i++) {
        slugToId[petalNames[i].toLowerCase().replace(/ /g, '_')] = i;
    }
    const mobNames = gameData.mobs.map(m => m.name);
    const mobSlugs = gameData.mobs.map(m => m.slug || m.name.toLowerCase().replace(/ /g, '_'));
    const snakeMobIndices = new Set(gameData.snakeMobIndices || []);
    const rarities = gameData.rarities;
    const variants = gameData.variants || [];

    // Pinky detection
    let PINKY_BITMASK = 2048;
    try {
        const srcData = gameData._source;
        if (srcData) {
            const pinkyMatch = srcData.match(/\.([a-zA-Z_$][\w$]*)\s*=\s*!!\(\s*(?:2048\s*&\s*[\w$]+|[\w$]+\s*&\s*2048)\s*\)/);
            if (pinkyMatch && pinkyMatch[1]) {
                console.log(`[AccountManager] Pinky property: player.${pinkyMatch[1]} (bitmask 2048)`);
            }
        }
    } catch (e) {
        console.log(`[AccountManager] Pinky detection error: ${e.message}`);
    }

    // Protocol version
    let protocolVersion = 443;
    try {
        const { version, jsUrl } = await extractProtocolVersion();
        protocolVersion = version;
        console.log(`[AccountManager] Protocol version: ${protocolVersion} (from ${jsUrl})`);
    } catch (e) {
        console.log(`[AccountManager] Protocol version fallback: ${protocolVersion}`);
    }

    console.log(`[AccountManager] Game data loaded: ${petalNames.length} petals, ${mobNames.length} mobs, ${rarities.length} rarities, ${variants.length} variants`);

    return { petalNames, slugToId, mobNames, mobSlugs, snakeMobIndices, rarities, variants, PINKY_BITMASK, protocolVersion };
}

// ── Read accounts from file ──
function readAccounts(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
}

// ── Fetch server list from map_server ──
function fetchServerList() {
    return new Promise((resolve, reject) => {
        http.get('http://localhost:3000/auto-patrol/servers', (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(e); }
            });
        }).on('error', reject);
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
    console.log('\x1b[1m\x1b[35m═══════════════════════════════════════════════════════');
    console.log('   Zorr Multi-Account Bot Manager');
    console.log('═══════════════════════════════════════════════════════\x1b[0m\n');

    // Load shared game data
    const sharedData = await loadGameData();

    // Read accounts
    const accountsPath = path.join(__dirname, 'accounts.txt');
    if (!fs.existsSync(accountsPath)) {
        console.error('\x1b[31m[AccountManager] accounts.txt not found\x1b[0m');
        process.exit(1);
    }
    const accountIds = readAccounts(accountsPath);
    if (accountIds.length === 0) {
        console.error('\x1b[31m[AccountManager] No accounts found in accounts.txt\x1b[0m');
        process.exit(1);
    }
    console.log(`[AccountManager] Found ${accountIds.length} accounts:`);
    accountIds.forEach((id, i) => console.log(`  ${i + 1}. ${id}`));

    // Fetch server list
    let servers;
    try {
        servers = await fetchServerList();
        console.log(`[AccountManager] Server list: ${servers.length} servers`);
    } catch (e) {
        console.error(`[AccountManager] Failed to fetch server list: ${e.message}`);
        console.log('[AccountManager] Falling back to empty server list (manual control only)');
        servers = [];
    }

    // Distribute servers
    const distributions = distributeServers(servers, accountIds.length);
    for (let i = 0; i < accountIds.length; i++) {
        console.log(`[AccountManager] Account ${accountIds[i].slice(0, 8)}: ${distributions[i].length} servers`);
    }

    // Create and start BotSessions
    const sessions = [];
    for (let i = 0; i < accountIds.length; i++) {
        const accountId = accountIds[i];
        const session = new BotSession(accountId, sharedData);
        sessions.push(session);
        console.log(`[AccountManager] Starting session for ${accountId.slice(0, 8)}...`);
        session.start(distributions[i]);
    }

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n[AccountManager] Shutting down...');
        for (const session of sessions) {
            session.stop();
        }
        process.exit(0);
    });

    console.log(`\x1b[32m[AccountManager] All ${sessions.length} sessions started\x1b[0m`);
}

main().catch(err => {
    console.error(`\x1b[31m[AccountManager] Fatal: ${err.message}\x1b[0m`);
    process.exit(1);
});
