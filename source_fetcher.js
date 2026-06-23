/**
 * source_fetcher.js
 *
 * Fetches the obfuscated Zorr game source from zorr.pages.dev.
 * No local file fallback — always live fetch.
 *
 * Provides:
 *   - fetchJsUrlFromHtml()  HTML only, returns current JS URL (~300ms)
 *   - fetchObfuscatedSource()  HTML + JS, returns source code (~1.3s)
 *
 * P9: Conditional GET support. httpGetWithMeta() returns both the body
 *     and the response headers (etag, last-modified). 304 Not Modified
 *     responses are surfaced as {notModified: true} so the caller can
 *     reuse the previous result without a body transfer.
 */
const https = require('https');

function httpGet(url, { headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', ...headers },
        }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                const loc = res.headers.location;
                if (loc) {
                    return httpGet(loc, { headers }).then(resolve, reject);
                }
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve(data));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(30000, () => req.destroy(new Error(`Timeout fetching ${url}`)));
    });
}

/**
 * P9: GET with conditional-request headers. Returns the body and the
 * relevant response headers. A 304 is resolved as {notModified: true}
 * with the previous headers echoed back.
 *
 * @param {string} url
 * @param {Object} [opts]
 * @param {string} [opts.etag]  If-None-Match value from a previous fetch
 * @param {string} [opts.lastModified]  If-Modified-Since value
 * @returns {Promise<{body: string, etag: string|null, lastModified: string|null, notModified: boolean}>}
 */
function httpGetWithMeta(url, { etag, lastModified } = {}) {
    const headers = {};
    if (etag) headers['If-None-Match'] = etag;
    if (lastModified) headers['If-Modified-Since'] = lastModified;
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', ...headers },
        }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                const loc = res.headers.location;
                if (loc) return httpGetWithMeta(loc, { etag, lastModified }).then(resolve, reject);
            }
            if (res.statusCode === 304) {
                return resolve({
                    body: '',
                    etag: res.headers.etag || etag || null,
                    lastModified: res.headers['last-modified'] || lastModified || null,
                    notModified: true,
                });
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({
                body: data,
                etag: res.headers.etag || null,
                lastModified: res.headers['last-modified'] || null,
                notModified: false,
            }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(30000, () => req.destroy(new Error(`Timeout fetching ${url}`)));
    });
}

const HTML_URL = 'https://zorr.pages.dev/';

// P9: ETag state for the HTML endpoint (the cheap, frequently-fetched one).
// Process-local only — disk cache does not store these (no source stored).
let _htmlEtag = null;
let _htmlLastModified = null;

function _resetHtmlMeta() { _htmlEtag = null; _htmlLastModified = null; }

/**
 * Fetch only the HTML and extract the current JS URL.
 * Cheap (~300ms) — use for cache invalidation checks.
 *
 * P9: Uses If-None-Match / If-Modified-Since. On 304, returns the
 * previously known jsUrl (from the most recent successful fetch).
 *
 * @param {Object} [opts]
 * @param {string} [opts.knownJsUrl]  jsUrl to return when 304 received
 * @returns {Promise<{jsUrl: string, htmlUrl: string, notModified?: boolean}>}
 */
async function fetchJsUrlFromHtml({ knownJsUrl } = {}) {
    const res = await httpGetWithMeta(HTML_URL, {
        etag: _htmlEtag,
        lastModified: _htmlLastModified,
    });
    _htmlEtag = res.etag;
    _htmlLastModified = res.lastModified;
    if (res.notModified) {
        if (!knownJsUrl) throw new Error('304 Not Modified but no knownJsUrl to return');
        return { jsUrl: knownJsUrl, htmlUrl: HTML_URL, notModified: true };
    }
    const match = res.body.match(/<script\s+src="([^"]+\.js[^"]*)"/i);
    if (!match) throw new Error('Cannot find <script src="...js"> in zorr.pages.dev HTML');
    let jsUrl = match[1];
    if (jsUrl.startsWith('/')) jsUrl = 'https://zorr.pages.dev' + jsUrl;
    else if (!jsUrl.startsWith('http')) jsUrl = 'https://zorr.pages.dev/' + jsUrl;
    return { jsUrl, htmlUrl: HTML_URL };
}

/**
 * Fetch the full obfuscated game source (HTML + JS).
 *
 * @returns {Promise<{source: string, jsUrl: string, htmlUrl: string}>}
 */
async function fetchObfuscatedSource() {
    const { jsUrl, htmlUrl } = await fetchJsUrlFromHtml();
    const source = await httpGet(jsUrl);
    return { source, jsUrl, htmlUrl };
}

module.exports = {
    fetchObfuscatedSource,
    fetchJsUrlFromHtml,
    httpGet,
    httpGetWithMeta,
    _resetHtmlMeta,
    getHtmlMeta: () => ({ etag: _htmlEtag, lastModified: _htmlLastModified }),
};
