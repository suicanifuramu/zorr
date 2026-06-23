/**
 * protocol_extractor.js
 *
 * Public facade for the protocol version extraction. The actual fetch + VM
 * work is in extraction_pipeline.js, shared with game_data_extractor.js.
 *
 * @deprecated Prefer `getOrComputeExtraction({ includeProtocol: true })` from
 *             extraction_pipeline.js. This wrapper remains for backward
 *             compatibility with bot_client*.js callers.
 */
const { getOrComputeExtraction } = require('./extraction_pipeline');

/**
 * @param {Object} [options]  passed through to the pipeline
 * @returns {Promise<{ version: number|null, jsUrl: string }>}
 */
async function extractProtocolVersion(options = {}) {
    const full = await getOrComputeExtraction({ ...options, includeProtocol: true });
    return { version: full.protocolVersion, jsUrl: full.jsUrl };
}

module.exports = { extractProtocolVersion };
