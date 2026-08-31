// run_capture.js — single-account runner (launches one BotSession from
// accounts.txt) for quick manual testing of login/spawn without running the
// full account_manager. Usage: node run_capture.js <accountId>
import "dotenv/config";

import { BotSession } from "./bot_session.js";
import { extractGameData } from "./game_data_extractor.js";
import { PINKY_BITMASK, assertFreshFor } from "./lib/bot/constants.js";

(async () => {
    const gameData = await extractGameData({ includeSource: false });
    const protocolVersion = gameData.protocolVersion ?? 443;
    // Fail fast if the game updated since the last constants extraction.
    assertFreshFor(gameData.sourceUrl);

    const petalNames = gameData.petals.map((p) => p.name);
    const slugToId = {};
    petalNames.forEach((n, i) => {
        slugToId[n.toLowerCase().replace(/ /g, "_")] = i;
    });
    const mobNames = gameData.mobs.map((m) => m.name);
    const mobSlugs = gameData.mobs.map((m) => m.slug || m.name.toLowerCase().replace(/ /g, "_"));
    const snakeMobIndices = new Set(gameData.snakeMobIndices || []);
    const rarities = gameData.rarities;
    const variants = gameData.variants || [];

    const sharedData = {
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

    const accountId = process.argv[2] || "dd6d4c29-87ba-47e3-bd23-49e3551d76d1";
    console.log(`[Capture] Starting session for ${accountId} (protocol ${protocolVersion})`);

    const session = new BotSession(accountId, sharedData, null, null, null);
    session.start([]);

    const timeoutMs = parseInt(process.argv[3] || "90000", 10);
    setTimeout(() => {
        console.log("[Capture] Window done — exiting.");
        process.exit(0);
    }, timeoutMs);
})().catch((e) => {
    console.error("[Capture] FATAL", e);
    process.exit(1);
});
