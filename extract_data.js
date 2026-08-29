const { getOrComputeExtraction } = require("./extraction_pipeline");

(async () => {
    console.log("[extract_data] Fetching + VM execution...");
    const result = await getOrComputeExtraction({ includeProtocol: true });
    console.log(`protocolVersion: ${result.protocolVersion}`);
    console.log(`vmRunMs: ${result.vmRunMs}ms`);
    console.log(`rarities: ${result.rarities.length}`);
    console.log(`variants: ${result.variants.length}`);
    console.log(`petals: ${result.petals.length}`);
    console.log(`mobs: ${result.mobs.length}`);
    console.log(`biomes: ${result.biomes.length}`);
    console.log(`regions: ${result.regions.length}`);
    console.log(`snakeMobIndices: ${result.snakeMobIndices.length}`);
    console.log(`jsUrl: ${result.jsUrl}`);
})().catch((e) => {
    console.error("[extract_data] Failed:", e.message);
    process.exit(1);
});
