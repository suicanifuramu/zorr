// run_capture.js — single-account runner (launches one BotSession from
// accounts.txt) for quick manual testing of login/spawn without running the
// full account_manager. Usage: node run_capture.js <accountId>
require('dotenv').config();

const { BotSession } = require('./bot_session');
const { extractGameData } = require('./game_data_extractor');
const { extractProtocolVersion } = require('./protocol_extractor');

(async () => {
    const gameData = await extractGameData({ includeSource: false });
    let protocolVersion = 443;
    try {
        const { version } = await extractProtocolVersion();
        protocolVersion = version;
    } catch (e) {
        console.log('[Capture] protocol version fallback:', protocolVersion);
    }

    const petalNames = gameData.petals.map(p => p.name);
    const slugToId = {};
    petalNames.forEach((n, i) => { slugToId[n.toLowerCase().replace(/ /g, '_')] = i; });
    const mobNames = gameData.mobs.map(m => m.name);
    const mobSlugs = gameData.mobs.map(m => m.slug || m.name.toLowerCase().replace(/ /g, '_'));
    const snakeMobIndices = new Set(gameData.snakeMobIndices || []);
    const rarities = gameData.rarities;
    const variants = gameData.variants || [];

    const sharedData = {
        petalNames, slugToId, mobNames, mobSlugs, snakeMobIndices,
        rarities, variants, PINKY_BITMASK: 2048, protocolVersion,
    };

    const accountId = process.argv[2] || 'dd6d4c29-87ba-47e3-bd23-49e3551d76d1';
    console.log(`[Capture] Starting session for ${accountId} (protocol ${protocolVersion})`);

    const session = new BotSession(accountId, sharedData, null, null, null);
    session.start([]);

    const timeoutMs = parseInt(process.argv[3] || '90000', 10);
    setTimeout(() => {
        console.log('[Capture] Window done — exiting.');
        process.exit(0);
    }, timeoutMs);
})().catch(e => { console.error('[Capture] FATAL', e); process.exit(1); });
