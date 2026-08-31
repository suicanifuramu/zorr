const canvas = document.getElementById("map-canvas");
const ctx = canvas.getContext("2d");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");

let mapData = null;
let mobs = [];
let botPos = { x: 0, y: 0 };
let botSpawned = false; // true = bot is in-game; false = on title screen or disconnected
let connectedRegion = "";
let connectedBiome = "";
let _viewerSwitching = false; // true while waiting for new server data after switch
let mapSize = 100000;
let targetPos = null;
let botHp = null;
let botIsPinky = false;
let navPath = []; // Path waypoints (cell coords) from bot's A*; empty when not navigating
let botHasNavigated = false; // true once bot has broadcast a non-empty navPath; used to clear targetPos on arrival
let localNavPath = []; // browser-side A* result (instant display on click)
let localNavPathTarget = null; // for staleness check
let lastBotPos = { x: 0, y: 0 }; // last known bot world pos (for A* start)

// === Zoom / Pan state ===
let zoomLevel = 1.0;
let panX = 0;
let panY = 0;

// === Multi-Account state ===
let accounts = {}; // accountId → { map, mobs, position, ap, status, botPos, botSpawned, ... }
let selectedAccountId = null;
let _accountPollTimer = null;
function gameToCanvas(gx, gy) {
    return [(gx / mapSize) * canvas.width * zoomLevel + panX, (gy / mapSize) * canvas.height * zoomLevel + panY];
}
function canvasToGame(cx, cy) {
    return [
        ((cx - panX) / (canvas.width * zoomLevel)) * mapSize,
        ((cy - panY) / (canvas.height * zoomLevel)) * mapSize,
    ];
}

// === Browser-side A* (1:1 mirror of bot_session.js computePath) ===
class MinHeap {
    constructor() {
        this.data = [];
    }
    get size() {
        return this.data.length;
    }
    push(item) {
        this.data.push(item);
        let i = this.data.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.data[p].f <= this.data[i].f) break;
            [this.data[p], this.data[i]] = [this.data[i], this.data[p]];
            i = p;
        }
    }
    pop() {
        const top = this.data[0];
        const last = this.data.pop();
        if (this.data.length > 0) {
            this.data[0] = last;
            let i = 0;
            while (true) {
                let smallest = i;
                const l = 2 * i + 1,
                    r = 2 * i + 2;
                if (l < this.data.length && this.data[l].f < this.data[smallest].f) smallest = l;
                if (r < this.data.length && this.data[r].f < this.data[smallest].f) smallest = r;
                if (smallest === i) break;
                [this.data[smallest], this.data[i]] = [this.data[i], this.data[smallest]];
                i = smallest;
            }
        }
        return top;
    }
}

// === Center-favoring A* pathfinding ===
const CENTER_COST = 25;
let _distanceMap = null;

function buildDistanceMap(grid, rows, cols) {
    const dist = Array.from({ length: rows }, () => Array(cols).fill(Infinity));
    const queue = [];
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            if (grid[y][x] === 0) {
                dist[y][x] = 0;
                queue.push([x, y]);
            }
        }
    }
    let head = 0;
    const dirs = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
    ];
    while (head < queue.length) {
        const [x, y] = queue[head++];
        for (const [dx, dy] of dirs) {
            const nx = x + dx,
                ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            if (dist[ny][nx] > dist[y][x] + 1) {
                dist[ny][nx] = dist[y][x] + 1;
                queue.push([nx, ny]);
            }
        }
    }
    return dist;
}

function findPathLocal(botWx, botWy, targetWx, targetWy, grid, gridWidth, mapSize) {
    if (!grid || !grid[0]) return [];
    const cSize = mapSize / gridWidth;
    const rows = grid.length;
    const cols = grid[0].length;
    let sx = Math.floor(botWx / cSize);
    let sy = Math.floor(botWy / cSize);
    let ex = Math.floor(targetWx / cSize);
    let ey = Math.floor(targetWy / cSize);
    if (sx < 0 || sx >= cols || sy < 0 || sy >= rows) return [];
    ex = Math.max(0, Math.min(cols - 1, ex));
    ey = Math.max(0, Math.min(rows - 1, ey));
    if (grid[sy][sx] === 0) return [];

    // Wall snap (5x5 search, mirror of bot line 1164-1180)
    if (grid[ey][ex] === 0) {
        let found = false,
            bestDist = Infinity,
            bx = ex,
            by = ey;
        for (let r = -2; r <= 2; r++) {
            for (let c = -2; c <= 2; c++) {
                const ny = ey + r,
                    nx = ex + c;
                if (ny >= 0 && ny < rows && nx >= 0 && nx < cols && grid[ny][nx] === 1) {
                    const d = Math.hypot(nx - ex, ny - ey);
                    if (d < bestDist) {
                        bestDist = d;
                        bx = nx;
                        by = ny;
                        found = true;
                    }
                }
            }
        }
        if (found) {
            ex = bx;
            ey = by;
        } else return [];
    }

    const key = (x, y) => x + "," + y;
    const startKey = key(sx, sy);
    const endKey = key(ex, ey);
    if (startKey === endKey) return [];

    const open = new MinHeap();
    open.push({ x: sx, y: sy, f: 0, g: 0 });
    const closedSet = new Set();
    const cameFrom = {};
    const gScore = { [startKey]: 0 };
    let found = false;
    let iterations = 0;

    while (open.size > 0 && iterations++ < 50000) {
        const cur = open.pop();
        const curKey = key(cur.x, cur.y);
        if (closedSet.has(curKey)) continue;
        closedSet.add(curKey);
        if (curKey === endKey) {
            found = true;
            break;
        }

        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = cur.x + dx,
                    ny = cur.y + dy;
                if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
                if (grid[ny][nx] === 0) continue;
                if (dx !== 0 && dy !== 0) {
                    if (grid[cur.y][nx] === 0 || grid[ny][cur.x] === 0) continue;
                }
                const nKey = key(nx, ny);
                if (closedSet.has(nKey)) continue;
                const baseCost = dx !== 0 && dy !== 0 ? 1.414 : 1;
                const wallDist = _distanceMap ? _distanceMap[ny][nx] : 10;
                const moveCost = baseCost + CENTER_COST / (wallDist + 1);
                const g = gScore[curKey] + moveCost;
                if (g < (gScore[nKey] ?? Infinity)) {
                    cameFrom[nKey] = curKey;
                    gScore[nKey] = g;
                    open.push({ x: nx, y: ny, f: g + Math.hypot(ex - nx, ey - ny), g });
                }
            }
        }
    }
    if (!found) return [];

    const path = [];
    let cur = endKey;
    while (cur) {
        const [cx, cy] = cur.split(",").map(Number);
        path.push([cx, cy]);
        cur = cameFrom[cur];
    }
    path.reverse();

    // Waypoint pruning (collinear, mirror of bot line 1243-1255)
    if (path.length <= 2) return path;
    const simplified = [path[0]];
    for (let i = 1; i < path.length - 1; i++) {
        const prev = path[i - 1],
            curr = path[i],
            next = path[i + 1];
        const d1x = curr[0] - prev[0],
            d1y = curr[1] - prev[1];
        const d2x = next[0] - curr[0],
            d2y = next[1] - curr[1];
        if (d1x !== d2x || d1y !== d2y) simplified.push(curr);
    }
    simplified.push(path[path.length - 1]);
    return simplified;
}
// Session id mirrors the bot's _currentSessionId. Stale broadcasts
// from a previous (switched-out) server carry an older session and
// are rejected here. -1 = no session received yet (initial state).
let currentSession = -1;

// Game config (received from server's /events SSE config message
// or fetched via /config). Empty until loaded.
let RARITIES = [];
let RARITY_BY_NAME = {};
let VARIANT_NAMES = {}; // {variantId: name}
let PETAL_BY_ID = {}; // {petalId: {name, slug, ...}}
let MOB_BY_ID = {}; // {mobId: {name, slug, ...}}
let SNAKE_MOB_IDS = new Set();
let currentServerBiomeName = "";

function applyConfig(cfg) {
    RARITIES = (cfg.rarities || []).map((r) => ({ name: r.name, color: r.color, weight: r.weight }));
    RARITY_BY_NAME = {};
    for (const r of RARITIES) RARITY_BY_NAME[r.name] = r;
    VARIANT_NAMES = {};
    for (const v of cfg.variants || []) VARIANT_NAMES[v.id] = v.name;
    PETAL_BY_ID = {};
    for (const p of cfg.petals || []) PETAL_BY_ID[p.id] = p;
    TALENT_BY_SLUG = {};
    for (const t of cfg.talents || []) TALENT_BY_SLUG[t.slug] = t;
    MOB_BY_ID = {};
    for (const m of cfg.mobs || []) MOB_BY_ID[m.id] = m;
    MOB_BY_SLUG = {};
    for (const m of cfg.mobs || []) MOB_BY_SLUG[m.slug] = m;
    BIOME_MOBS = cfg.biomeMobs || {};
    CONFIG_BIOMES = cfg.biomes || [];
    // Compute "other" tab: mobs not in any biome
    const allBiomeSlugs = new Set();
    for (const slugs of Object.values(BIOME_MOBS)) {
        for (const s of slugs) allBiomeSlugs.add(s);
    }
    const otherSlugs = (cfg.mobs || []).filter((m) => !allBiomeSlugs.has(m.slug)).map((m) => m.slug);
    if (otherSlugs.length > 0) BIOME_MOBS.other = otherSlugs;
    SNAKE_MOB_IDS = new Set(cfg.snakeMobIndices || []);
    _populateRarityFilter();
}

// Rarity filter dropdown options (empty selection = show all rarities)
function _populateRarityFilter() {
    const sel = document.getElementById("mob-filter-rarity");
    if (!sel) return;
    sel.innerHTML = RARITIES.map((r, i) => `<option value="${i}" style="color:${r.color}">${r.name}</option>`).join("");
}

// Populate region/biome <select> options from the VM-extracted lists.
// When extraction failed, the cfg has empty arrays → dropdowns stay empty
// (per the "抽出失敗時は空ドロップダウン" policy).
function populateServerControls(cfg) {
    const regionSelect = document.getElementById("region-select");
    const biomeSelect = document.getElementById("biome-select");
    if (!regionSelect || !biomeSelect) return;

    const regions = Array.isArray(cfg.regions) ? cfg.regions : [];
    const biomes = Array.isArray(cfg.biomes) ? cfg.biomes : [];

    regionSelect.innerHTML = regions
        .map((r) => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name.toUpperCase())}</option>`)
        .join("");
    biomeSelect.innerHTML = biomes
        .map(
            (b) =>
                `<option value="${escapeHtml(b.name)}" style="color:${escapeHtml(b.color || "inherit")}">${escapeHtml(b.name.charAt(0).toUpperCase() + b.name.slice(1))}</option>`
        )
        .join("");

    // If selection was wiped, ensure the switches stay disabled
    const switchBtn = document.getElementById("switch-btn");
    if (switchBtn) switchBtn.disabled = regions.length === 0 || biomes.length === 0;
}

function escapeHtml(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

const mobListEl = document.getElementById("mob-list");
const mobCountEl = document.getElementById("mob-count");
const equipListEl = document.getElementById("equip-list");

let lastPetals = [];
let lastTalents = [];
let TALENT_BY_SLUG = {};
let MOB_BY_SLUG = {};
let BIOME_MOBS = {};
let CONFIG_BIOMES = [];

// Connect to SSE
const eventSource = new EventSource("/events");

eventSource.onopen = () => {
    statusDot.classList.add("connected");
    statusText.textContent = "接続完了";
};

eventSource.onerror = () => {
    statusDot.classList.remove("connected");
    statusText.textContent = "オフライン";
};

eventSource.onmessage = (event) => {
    try {
        const data = JSON.parse(event.data);
        handleMapData(data);
    } catch (e) {
        console.error("Parse error:", e);
    }
};

// Fallback: fetch /config in case the SSE config message was missed
// (e.g. page reload after the bot pushed its first event).
fetch("/config")
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => {
        if (cfg && cfg.schemaVersion) {
            applyConfig(cfg);
            populateServerControls(cfg);
            drawMap();
        }
    })
    .catch(() => {});

// Load accounts list on startup
fetch("/accounts")
    .then((r) => (r.ok ? r.json() : null))
    .then((result) => {
        const accts = result?.accounts || result || [];
        if (Array.isArray(accts)) {
            accts.forEach((ac) => {
                const id = ac.accountId || ac;
                if (!accounts[id]) accounts[id] = {};
                if (ac.username) accounts[id].username = ac.username;
                if (ac.biomeName) accounts[id].biome = ac.biomeName;
                if (ac.region) accounts[id].region = ac.region;
                if (ac.state) accounts[id].status = ac.state;
                if (ac.active !== undefined || ac.state) {
                    accounts[id].ap = {
                        active: ac.active || false,
                        state: ac.state || "idle",
                        pinkyFailCount: ac.pinkyFailCount || 0,
                        currentServer: ac.currentServer || null,
                        serverIndex: ac.serverIndex || 0,
                        serverCount: ac.serverCount || 0,
                        log: ac.log || [],
                    };
                }
            });
            renderAccountList();
            // Auto-select first account if none selected yet
            if (!selectedAccountId && Object.keys(accounts).length > 0) {
                selectAccount(Object.keys(accounts)[0]);
            }
        }
    })
    .catch(() => {});

// Fallback: fetch /mapdata to recover any missed SSE events
// (e.g. page opened before the bot pushed its first broadcast,
// or the SSE push happened during the EventSource handshake).
// This eliminates the "restart bot to see map" bug.
fetch("/mapdata")
    .then((r) => (r.ok ? r.json() : null))
    .then((snapshot) => {
        if (!snapshot) return;
        for (const [acId, sessionData] of Object.entries(snapshot)) {
            if (typeof sessionData !== "object" || sessionData === null) continue;
            for (const type of ["config", "map", "position", "mobs", "auto-patrol"]) {
                if (sessionData[type]) {
                    handleMapData({ ...sessionData[type], accountId: acId });
                }
            }
        }
    })
    .catch(() => {});

// Periodic safety-net poll: re-fetch /mapdata every 5s.
// Catches SSE events dropped by the browser EventSource (e.g. during
// initial handshake, or while the tab was in the background).
// handleMapData is idempotent for each type, so repeated calls are safe.
setInterval(() => {
    fetch("/mapdata")
        .then((r) => (r.ok ? r.json() : null))
        .then((snapshot) => {
            if (!snapshot) return;
            for (const [acId, sessionData] of Object.entries(snapshot)) {
                if (typeof sessionData !== "object" || sessionData === null) continue;
                for (const type of ["config", "map", "position", "mobs", "auto-patrol"]) {
                    if (sessionData[type]) {
                        handleMapData({ ...sessionData[type], accountId: acId });
                    }
                }
            }
        })
        .catch(() => {});
}, 5000);

function handleMapData(data) {
    // === Multi-account routing ===
    const acId = data.accountId || null;
    if (acId) {
        if (!accounts[acId]) accounts[acId] = {};
        const ac = accounts[acId];
        if (data.username) ac.username = data.username;
        if (data.type === "map") {
            ac.map = data;
            ac.biome = data.biomeName || "";
            ac.region = data.region || "";
        } else if (data.type === "position") {
            ac.position = data;
            ac.botPos = { x: data.x, y: data.y };
            ac.botSpawned = true;
        } else if (data.type === "mobs") {
            ac.mobs = data.mobs || [];
        } else if (data.type === "auto-patrol") {
            ac.ap = data;
            ac.status = data.state || "idle";
        } else if (data.type === "despawn") {
            ac.botSpawned = false;
            ac.status = "title";
        } else if (data.type === "account-disconnect") {
            ac.botSpawned = false;
            ac.status = "disconnected";
        }
        renderAccountList();
    }

    // If this data has an accountId but no account is selected yet, skip global UI update
    // If this data is NOT for the selected account, also skip global UI update
    // (but still store in accounts above)
    if (acId && (!selectedAccountId || acId !== selectedAccountId)) return;

    // === Global UI update (for selected account or legacy single-bot) ===
    if (data.type === "auto-patrol") {
        updateAutoPatrolUI(data);
    }
    if (data.type === "switch") {
        if (!acId || acId === selectedAccountId) {
            clearViewerState();
            _viewerSwitching = true;
        }
        return;
    }
    if (data.type === "despawn") {
        if (data.session !== undefined && currentSession !== -1 && data.session !== currentSession) return;
        botSpawned = false;
        targetPos = null;
        navPath = [];
        localNavPath = [];
        drawMap();
        return;
    }
    if (data.type === "config") {
        const cfg = data;
        delete cfg.type;
        applyConfig(cfg);
    } else if (data.type === "map") {
        // Session filter: drop stale map data from a previous server.
        // When currentSession is -1 (initial / post-clear), accept.
        if (_viewerSwitching) {
            if (data.session === undefined) return; // ignore stale data without session during switch
            _viewerSwitching = false; // new server data arrived
        }
        if (data.session !== undefined && currentSession !== -1 && data.session !== currentSession) return;
        if (data.session !== undefined) currentSession = data.session;
        mapData = data;
        document.getElementById("map-name").textContent = data.mapName || "-";
        document.getElementById("biome-name").textContent = data.biomeName || "-";
        connectedRegion = data.region || "";
        connectedBiome = data.serverBiome || data.biomeName || "";
        currentServerBiomeName = data.biomeName || "";
        mapSize = data.mapSize || 100000;
        // Pre-compute wall-distance map for center-favoring A*
        if (data.grid && data.gridWidth) {
            _distanceMap = buildDistanceMap(data.grid, data.gridWidth, data.gridWidth);
        }
        routePreviewKey = null;
        rebuildRouteDirectory();
    } else if (data.type === "position") {
        if (_viewerSwitching) return; // ignore until type:'map' arrives from new server
        if (data.session !== undefined && currentSession !== -1 && data.session !== currentSession) return;
        if (data.session !== undefined) currentSession = data.session;
        botSpawned = true;
        botPos = { x: data.x, y: data.y };
        lastBotPos = { x: data.x, y: data.y };
        // Path update: field absent or empty = no active path
        navPath = Array.isArray(data.navPath) ? data.navPath : [];
        // Discard stale local path when bot broadcasts its own.
        if (navPath.length > 0) {
            localNavPath = [];
            localNavPathTarget = null;
        }
        // Arrival detection: once the bot has had an active path and
        // now reports none, clear the click point if the bot is
        // within ~1.5 cells of the target (covers both exact hits
        // and wall-snaps to an adjacent walkable cell).
        if (navPath.length > 0) {
            botHasNavigated = true;
        } else if (botHasNavigated && targetPos) {
            const cSize = mapData && mapData.gridWidth ? mapSize / mapData.gridWidth : 1000;
            const threshold = cSize * 1.5;
            const dx = botPos.x - targetPos.x;
            const dy = botPos.y - targetPos.y;
            if (dx * dx + dy * dy < threshold * threshold) {
                targetPos = null;
                botHasNavigated = false;
                localNavPath = [];
                localNavPathTarget = null;
            }
        }
        const server = connectedRegion && connectedBiome ? `${connectedRegion}-${connectedBiome}` : "";
        const serverPart = server ? ` | ${server}` : "";
        document.getElementById("pos-grid-info").textContent =
            `pos: ${Math.round(data.x)}, ${Math.round(data.y)} | grid: ${Math.floor(data.x / 500)}, ${Math.floor(data.y / 500)}${serverPart}`;
        if (data.hp !== undefined) {
            botHp = data.hp;
        }
        if (data.petals) {
            lastPetals = data.petals;
            lastTalents = data.talents || [];
            renderEquip();
        }
        if (data.isPinky !== undefined) {
            botIsPinky = data.isPinky;
            const badge = document.getElementById("pinky-badge");
            if (badge) {
                badge.textContent = "Pinky: " + (botIsPinky ? "true" : "false");
                badge.className = "pinky-badge " + (botIsPinky ? "active" : "inactive");
            }
        }
    } else if (data.type === "mobs") {
        if (_viewerSwitching) return; // ignore until type:'map' arrives from new server
        if (data.session !== undefined && currentSession !== -1 && data.session !== currentSession) return;
        if (data.session !== undefined) currentSession = data.session;
        mobs = data.mobs || [];
        renderMobList();
    } else if (data.type === "auto-patrol") {
        updateAutoPatrolUI(data);
    }
    drawMap();
}

// ── Mob list filters (display-only; map rendering is unaffected) ──
window.mobFilterText = "";
window.mobFilterRarities = new Set(); // empty = show all
window.MOB_LIST_CAP = 300; // ponytail: DOM cap; raise if you really scroll that far

function _mobMatchesFilter(mob) {
    if (window.mobFilterRarities.size > 0 && !window.mobFilterRarities.has(mob.rarity)) return false;
    if (window.mobFilterText) {
        const q = window.mobFilterText.toLowerCase();
        const vName = (VARIANT_NAMES[mob.variant] || "").toLowerCase();
        if (!(mob.name.toLowerCase().includes(q) || vName.includes(q))) return false;
    }
    return true;
}

function renderMobList() {
    const filtered = mobs.filter(_mobMatchesFilter);
    mobCountEl.textContent =
        window.mobFilterText || window.mobFilterRarities.size ? `${filtered.length}/${mobs.length}` : mobs.length;
    const shown = filtered.slice(0, window.MOB_LIST_CAP);
    mobListEl.innerHTML = shown
        .map((mob) => {
            const r = RARITIES[mob.rarity] || RARITIES[0];
            const vName = VARIANT_NAMES[mob.variant];
            const variantLabel = vName && vName !== "Normal" ? ` <span class="mob-variant">${vName}</span>` : "";
            return `<div class="mob-item">
                    <span class="mob-name">${mob.name}${variantLabel}</span>
                    <span class="mob-rarity" style="color:${r.color};background:${r.color}22;border:1px solid ${r.color}44">${r.name}</span>
                    <span class="mob-dist">(${Math.floor(mob.x / 500)}, ${Math.floor(mob.y / 500)})</span>
                </div>`;
        })
        .join("");
    if (filtered.length > window.MOB_LIST_CAP) {
        mobListEl.innerHTML += `<div class="mob-item" style="color:#6b7280;justify-content:center">…他 ${filtered.length - window.MOB_LIST_CAP} 体</div>`;
    }
}

function renderEquip() {
    if (!lastPetals.length && !lastTalents.length) {
        equipListEl.innerHTML =
            '<div style="color:#6b7280;font-size:11px;text-align:center;padding:20px 10px;">装備なし</div>';
        return;
    }
    let html = lastPetals
        .map((p) => {
            const r = RARITIES.find((rr) => rr.name === p.rarityName) || RARITIES[0];
            return `<div class="equip-item">
                    <span class="equip-petal">${p.petalName}</span>
                    <span class="equip-rarity" style="color:${r.color};background:${r.color}22;border:1px solid ${r.color}44">${p.rarityName}</span>
                </div>`;
        })
        .join("");
    if (lastTalents.length > 0) {
        html += `<div class="equip-item" style="border-top:1px solid rgba(100,100,255,0.2);margin-top:4px;padding-top:4px;">
                    <span class="equip-petal" style="color:#818cf8;font-size:10px">Talents: ${lastTalents.join(", ")}</span>
                </div>`;
    }
    equipListEl.innerHTML = html;
}

function renderHpBar() {
    const el = document.getElementById("hp-bar");
    if (!el) return;
    const hpVal = botHp !== null ? parseFloat(botHp) : 0;
    const hpColor = hpVal > 50 ? "#22c55e" : hpVal > 25 ? "#eab308" : "#ef4444";
    el.innerHTML = `
                <div class="hp-section">
                    <span class="hp-label">HP</span>
                    <div class="hp-track"><div class="hp-fill" style="width:${hpVal}%;background:${hpColor}"></div></div>
                    <span class="hp-text">${hpVal.toFixed(1)}%</span>
                </div>
            `;
}

// ── Offscreen grid cache: the walkable-grid layer only changes when the
// map data / zoom / pan / canvas size change, not on every mob update.
// Rebuilt lazily and blitted with drawImage (one op vs rows*cols fillRects).
let _gridCache = null;
let _gridKey = "";
function _gridCacheKey() {
    return mapData && mapData.grid
        ? `${mapData.mapName}|${mapData.gridWidth}|${canvas.width}x${canvas.height}|${zoomLevel.toFixed(4)}|${panX.toFixed(1)}|${panY.toFixed(1)}`
        : "";
}
function _rebuildGridCache() {
    const grid = mapData.grid;
    const rows = grid.length;
    const cols = grid[0].length;
    const cs = mapSize / mapData.gridWidth;
    if (!_gridCache) _gridCache = document.createElement("canvas");
    _gridCache.width = canvas.width;
    _gridCache.height = canvas.height;
    const gctx = _gridCache.getContext("2d");
    gctx.clearRect(0, 0, _gridCache.width, _gridCache.height);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            gctx.fillStyle = grid[r][c] === 1 ? "#0d1520" : "#2a3a54";
            const [x1, y1] = gameToCanvas(c * cs, r * cs);
            const [x2, y2] = gameToCanvas((c + 1) * cs, (r + 1) * cs);
            gctx.fillRect(x1, y1, x2 - x1 - 1, y2 - y1 - 1);
        }
    }
}

function drawMap() {
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    if (!mapData || !mapData.grid) {
        ctx.fillStyle = "#6b7280";
        ctx.font = "16px sans-serif";
        ctx.textAlign = "center";
        if (currentSession === -1) {
            ctx.fillText("🔄 切替中...", width / 2, height / 2);
        } else {
            ctx.fillText("マップデータ待ち...", width / 2, height / 2);
        }
        return;
    }

    const grid = mapData.grid;
    const rows = grid.length;
    const cols = grid[0].length;
    const cellSize = mapSize / mapData.gridWidth;

    // Grid layer: blit from offscreen cache when possible
    const gridKey = _gridCacheKey();
    if (gridKey !== _gridKey) {
        _rebuildGridCache();
        _gridKey = gridKey;
    }
    if (_gridCache) ctx.drawImage(_gridCache, 0, 0);

    // Draw mobs
    for (const mob of mobs) {
        const [mx, my] = gameToCanvas(mob.x, mob.y);
        const r = RARITIES[mob.rarity] || RARITIES[0];
        ctx.fillStyle = r.color;
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.arc(mx, my, 3, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Draw nav path
    const pathToDraw = localNavPath && localNavPath.length > 0 ? localNavPath : navPath;
    if (botSpawned && pathToDraw && pathToDraw.length > 0 && mapData.gridWidth > 0) {
        let renderPath = pathToDraw;
        if (renderPath === localNavPath && renderPath.length > 1) {
            const cSize = mapSize / mapData.gridWidth;
            const botCX = Math.floor(botPos.x / cSize);
            const botCY = Math.floor(botPos.y / cSize);
            let closestIdx = 0,
                closestDist = Infinity;
            for (let i = 0; i < renderPath.length; i++) {
                const d = Math.abs(renderPath[i][0] - botCX) + Math.abs(renderPath[i][1] - botCY);
                if (d < closestDist) {
                    closestDist = d;
                    closestIdx = i;
                }
            }
            if (closestIdx > 0) renderPath = renderPath.slice(closestIdx);
        }
        ctx.save();
        ctx.strokeStyle = "rgba(0, 255, 204, 0.8)";
        ctx.lineWidth = 3;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.shadowBlur = 6;
        ctx.shadowColor = "#00ffcc";
        ctx.beginPath();
        const [bx0, by0] = gameToCanvas(botPos.x, botPos.y);
        ctx.moveTo(bx0, by0);
        for (const cell of renderPath) {
            const [px, py] = gameToCanvas((cell[0] + 0.5) * cellSize, (cell[1] + 0.5) * cellSize);
            ctx.lineTo(px, py);
        }
        ctx.stroke();
        const last = renderPath[renderPath.length - 1];
        const [lx, ly] = gameToCanvas((last[0] + 0.5) * cellSize, (last[1] + 0.5) * cellSize);
        ctx.fillStyle = "#ff3366";
        ctx.shadowColor = "#ff3366";
        ctx.beginPath();
        ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    // Draw bot
    if (botSpawned) {
        const [bx, by] = gameToCanvas(botPos.x, botPos.y);
        ctx.fillStyle = botIsPinky ? "#ff66cc" : "#00ff66";
        ctx.beginPath();
        ctx.arc(bx, by, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = botIsPinky ? "#ff66cc" : "#00ff66";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(bx, by, 8, 0, Math.PI * 2);
        ctx.stroke();
    }

    // Draw target
    if (targetPos) {
        const [tx, ty] = gameToCanvas(targetPos.x, targetPos.y);
        ctx.fillStyle = "#ff4444";
        ctx.beginPath();
        ctx.arc(tx, ty, 3, 0, Math.PI * 2);
        ctx.fill();
    }

    // Draw routes
    const drawRoute = (waypoints, color, editMode) => {
        if (!waypoints || waypoints.length === 0) return;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.shadowBlur = 4;
        ctx.shadowColor = color;
        if (waypoints.length >= 2) {
            ctx.beginPath();
            for (let i = 0; i < waypoints.length; i++) {
                const [rx, ry] = gameToCanvas(waypoints[i].x, waypoints[i].y);
                if (i === 0) ctx.moveTo(rx, ry);
                else ctx.lineTo(rx, ry);
            }
            ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.font = "9px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (let i = 0; i < waypoints.length; i++) {
            const [rx, ry] = gameToCanvas(waypoints[i].x, waypoints[i].y);
            const isSelected = editMode && i === routeSelectedIdx;
            ctx.fillStyle = isSelected ? "#ffdd00" : color;
            ctx.beginPath();
            ctx.arc(rx, ry, isSelected ? 6 : 3.5, 0, Math.PI * 2);
            ctx.fill();
            if (isSelected) {
                ctx.strokeStyle = "#fff";
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }
            ctx.fillStyle = isSelected ? "#000" : "#fff";
            ctx.fillText(i + 1, rx, ry);
        }
        ctx.restore();
    };
    if (routeEditMode && routeCurrentWaypoints.length > 0) {
        drawRoute(routeCurrentWaypoints, "rgba(255, 220, 0, 0.85)", true);
    } else if (routeRecording && routeCurrentWaypoints.length > 0) {
        drawRoute(routeCurrentWaypoints, "rgba(0, 162, 255, 0.85)", false);
    } else if (routePreviewKey && customRoutes[routePreviewKey]) {
        drawRoute(customRoutes[routePreviewKey], "rgba(255, 255, 204, 0.7)", false);
    } else {
        const activeKey = getRouteMapKey();
        if (activeKey && customRoutes[activeKey]) {
            drawRoute(customRoutes[activeKey], "rgba(102, 255, 102, 0.7)", false);
        }
    }
}

// Handle canvas resize
function resizeCanvas() {
    const container = document.querySelector(".map-container");
    const size = Math.min(container.clientWidth - 40, container.clientHeight - 40, 800);
    canvas.width = size;
    canvas.height = size;
    drawMap();
}

// Click to navigate (wall cells are rejected — no movement issued)
canvas.addEventListener("click", (e) => {
    if (!mapData) return;
    if (routeRecording) return;
    if (routeEditMode) return;
    if (_dragMoved) return;
    const [wx, wy] = canvasToGame(
        e.clientX - e.target.getBoundingClientRect().left,
        e.clientY - e.target.getBoundingClientRect().top
    );
    // Reject clicks on wall cells (grid=0)
    if (mapData.grid && mapData.gridWidth) {
        const cellSize = mapSize / mapData.gridWidth;
        const cellX = Math.floor(wx / cellSize);
        const cellY = Math.floor(wy / cellSize);
        const row = mapData.grid[cellY];
        if (cellX >= 0 && cellY >= 0 && cellY < mapData.grid.length && row && cellX < row.length && row[cellX] === 0) {
            return;
        }
    }
    targetPos = { x: wx, y: wy };
    botHasNavigated = false;
    navPath = [];
    if (mapData.grid && mapData.gridWidth && mapData.mapSize) {
        localNavPath = findPathLocal(
            lastBotPos.x,
            lastBotPos.y,
            wx,
            wy,
            mapData.grid,
            mapData.gridWidth,
            mapData.mapSize
        );
        localNavPathTarget = { x: wx, y: wy };
    }
    drawMap();
    fetch("/navigate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            x: Math.round(wx),
            y: Math.round(wy),
            accountId: selectedAccountId || undefined,
        }),
    }).catch(() => {});
});

// Death button
function sendDeath() {
    fetch("/death", { method: "POST" }).catch(() => {});
}

// Title button: return to title screen (no auto-respawn)
function sendTitle() {
    fetch("/title", { method: "POST" }).catch(() => {});
}

// Play button: re-enter game from title screen
function sendSpawn() {
    fetch("/spawn", { method: "POST" }).catch(() => {});
}

// Attack/Defend toggle buttons
let uiAttackActive = false;
let uiDefendActive = false;

async function toggleAttack() {
    try {
        const r = await fetch("/attack/toggle", { method: "POST" });
        const s = await r.json();
        uiAttackActive = !!s.active;
        updateActionButton("attack-btn", "Attack", uiAttackActive);
    } catch (e) {
        /* ignore */
    }
}

async function toggleDefend() {
    try {
        const r = await fetch("/defend/toggle", { method: "POST" });
        const s = await r.json();
        uiDefendActive = !!s.active;
        updateActionButton("defend-btn", "Defend", uiDefendActive);
    } catch (e) {
        /* ignore */
    }
}

function updateActionButton(id, label, active) {
    const btn = document.getElementById(id);
    btn.textContent = `${label}: ${active ? "ON" : "OFF"}`;
    btn.classList.toggle("active", active);
}

// Reflect current server-side state on page load (toggle state persists across reloads)
fetch("/state")
    .then((r) => r.json())
    .then((s) => {
        uiAttackActive = !!s.attack;
        uiDefendActive = !!s.defend;
        updateActionButton("attack-btn", "Attack", uiAttackActive);
        updateActionButton("defend-btn", "Defend", uiDefendActive);
    })
    .catch(() => {});

// Equip buttons
function sendEquip(file, accountId) {
    fetch("/equip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buildFile: file, accountId: accountId || null }),
    }).catch(() => {});
}

// ━━━━━━ Account Panel ━━━━━━
let accountExpanded = true;
function toggleAccountPanel() {
    accountExpanded = !accountExpanded;
    document.getElementById("account-body").style.display = accountExpanded ? "block" : "none";
    document.getElementById("ac-toggle").className = "ap-toggle" + (accountExpanded ? " open" : "");
}
function renderAccountList() {
    const el = document.getElementById("account-list");
    if (!el) return;
    const ids = Object.keys(accounts);
    if (ids.length === 0) {
        if (!el.dataset.empty) {
            el.innerHTML =
                '<div style="color:#6b7280;font-size:11px;text-align:center;padding:12px;">No accounts</div>';
            el.dataset.empty = "1";
        }
        return;
    }
    delete el.dataset.empty;

    // Incremental update: create/patch/remove child elements without innerHTML
    const existing = el.querySelectorAll(".account-item");
    const existingMap = {};
    existing.forEach((item) => {
        existingMap[item.dataset.id] = item;
    });

    const seenIds = new Set();
    for (const id of ids) {
        seenIds.add(id);
        const ac = accounts[id];
        const isActive = id === selectedAccountId;
        const statusClass =
            ac.status === "patrolling"
                ? "patrolling"
                : ac.status === "pinky"
                  ? "pinky"
                  : ac.status === "moving"
                    ? "moving"
                    : "";
        const displayName = ac.username || id.substring(0, 8);
        const biome = ac.biome || "-";
        const region = ac.region || "-";
        const stateLabel = ac.ap ? ac.ap.state || "idle" : "idle";
        const patrolActive = ac.ap && ac.ap.active;
        const cls = `account-item ${statusClass} ${isActive ? "active" : ""}`;

        let item = existingMap[id];
        if (!item) {
            // Create new element
            item = document.createElement("div");
            item.className = cls;
            item.dataset.id = id;
            item.onclick = () => selectAccount(id);
            item.innerHTML = `<div class="account-item-info"><div class="account-item-id"></div><div class="account-item-status"></div></div><button class="account-item-btn"></button>`;
            item.querySelector(".account-item-btn").onclick = (e) => {
                e.stopPropagation();
                toggleAccountPatrol(id);
            };
            el.appendChild(item);
        }

        // Patch class only if changed
        if (item.className !== cls) item.className = cls;

        // Patch text content only if changed
        const idEl = item.querySelector(".account-item-id");
        const statusEl = item.querySelector(".account-item-status");
        const btnEl = item.querySelector(".account-item-btn");
        if (idEl.textContent !== displayName) idEl.textContent = displayName;
        const statusText = `${region}-${biome} · ${stateLabel}`;
        if (statusEl.textContent !== statusText) statusEl.textContent = statusText;
        const btnCls = `account-item-btn ${patrolActive ? "running" : ""}`;
        if (btnEl.className !== btnCls) btnEl.className = btnCls;
        const btnText = patrolActive ? "■ Stop" : "▶ Start";
        if (btnEl.textContent !== btnText) btnEl.textContent = btnText;
    }

    // Remove stale elements
    existing.forEach((item) => {
        if (!seenIds.has(item.dataset.id)) item.remove();
    });
}
function selectAccount(id) {
    selectedAccountId = id;
    _viewerSwitching = false;
    currentSession = -1;
    const ac = accounts[id];
    if (ac && ac.map) {
        // Load this account's data into global UI
        mapData = ac.map;
        document.getElementById("map-name").textContent = ac.map.mapName || "-";
        document.getElementById("biome-name").textContent = ac.map.biomeName || "-";
        connectedRegion = ac.map.region || "";
        connectedBiome = ac.map.serverBiome || ac.map.biomeName || "";
        currentServerBiomeName = ac.map.biomeName || "";
        mapSize = ac.map.mapSize || 100000;
        if (ac.map.grid && ac.map.gridWidth) {
            _distanceMap = buildDistanceMap(ac.map.grid, ac.map.gridWidth, ac.map.gridWidth);
        }
        rebuildRouteDirectory();
    }
    if (ac && ac.position) {
        botSpawned = true;
        botPos = ac.botPos || { x: ac.position.x, y: ac.position.y };
        lastBotPos = { ...botPos };
        navPath = Array.isArray(ac.position.navPath) ? ac.position.navPath : [];
        if (ac.position.hp !== undefined) botHp = ac.position.hp;
        if (ac.position.isPinky !== undefined) botIsPinky = ac.position.isPinky;
    } else {
        botSpawned = false;
        navPath = [];
    }
    mobs = ac && ac.mobs ? ac.mobs : [];
    if (ac && ac.ap) updateAutoPatrolUI(ac.ap);
    if (ac && ac.position && ac.position.petals) {
        lastPetals = ac.position.petals;
        lastTalents = ac.position.talents || [];
    } else {
        lastPetals = [];
        lastTalents = [];
    }
    renderEquip();
    renderAccountList();
    renderMobList();
    drawMap();
}
function toggleAccountPatrol(id) {
    const ac = accounts[id];
    if (!ac) return;
    if (ac.ap && ac.ap.active) {
        fetch("/auto-patrol/stop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId: id }),
        }).catch(() => {});
    } else {
        fetch("/auto-patrol/servers")
            .then((r) => r.json())
            .then((servers) => {
                if (!servers || servers.length === 0) {
                    alert("No servers with routes found");
                    return;
                }
                return fetch("/auto-patrol/start", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ servers, accountId: id }),
                });
            })
            .catch(() => {});
    }
}
function startAllPatrol() {
    fetch("/auto-patrol/servers")
        .then((r) => r.json())
        .then((servers) => {
            if (!servers || servers.length === 0) {
                alert("No servers with routes found");
                return;
            }
            return fetch("/auto-patrol/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ servers }),
            });
        })
        .catch(() => {});
}
function stopAllPatrol() {
    fetch("/auto-patrol/stop", { method: "POST" }).catch(() => {});
}

// ━━━━━━ Auto Patrol UI ━━━━━━
let apExpanded = false;
function toggleAutoPatrol() {
    apExpanded = !apExpanded;
    document.getElementById("ap-body").style.display = apExpanded ? "block" : "none";
    document.getElementById("ap-toggle").className = "ap-toggle" + (apExpanded ? " open" : "");
}
function startAutoPatrol() {
    fetch("/auto-patrol/servers")
        .then((r) => r.json())
        .then((servers) => {
            if (!servers || servers.length === 0) {
                alert("No servers with routes found");
                return;
            }
            return fetch("/auto-patrol/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ servers }),
            });
        })
        .catch(() => {});
}
function stopAutoPatrol() {
    fetch("/auto-patrol/stop", { method: "POST" }).catch(() => {});
}
function updateAutoPatrolUI(data) {
    const stateEl = document.getElementById("ap-state");
    const serverEl = document.getElementById("ap-server");
    const pinkyFailEl = document.getElementById("ap-pinky-fail");
    const logEl = document.getElementById("ap-log");
    const startBtn = document.getElementById("ap-start-btn");
    const stopBtn = document.getElementById("ap-stop-btn");
    if (stateEl) stateEl.textContent = data.state || "idle";
    if (serverEl)
        serverEl.textContent = data.currentServer ? `${data.currentServer.region}-${data.currentServer.biome}` : "-";
    if (pinkyFailEl) pinkyFailEl.textContent = `${data.pinkyFailCount || 0}/3`;
    if (startBtn) startBtn.style.display = data.active ? "none" : "";
    if (stopBtn) stopBtn.style.display = data.active ? "" : "none";
    if (logEl && data.log) {
        logEl.innerHTML = data.log.map((l) => `<div>${escapeHtml(l)}</div>`).join("");
        logEl.scrollTop = logEl.scrollHeight;
    }
}

// Server switch: POST region/biome to map_server, which proxies to bot.
function switchServer() {
    const region = document.getElementById("region-select").value;
    const biome = document.getElementById("biome-select").value;
    if (!region || !biome) return;
    const btn = document.getElementById("switch-btn");
    btn.disabled = true;
    btn.textContent = "⏳ Switching…";
    // Wipe local state immediately so stale mobs/map from the
    // previous server are not rendered during the ~1s reconnect.
    clearViewerState();
    _viewerSwitching = true;
    fetch("/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region, biome }),
    })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then(() => {
            btn.textContent = "Switched";
            setTimeout(() => {
                btn.textContent = "Switch";
                btn.disabled = false;
            }, 1500);
        })
        .catch((e) => {
            btn.textContent = "Failed";
            console.error("switch failed:", e);
            setTimeout(() => {
                btn.textContent = "Switch";
                btn.disabled = false;
            }, 2000);
        });
}

// Reset all per-server viewer state. Called from switchServer() and
// from handleMapData() when an SSE 'switch' event is received (covers
// switches initiated from another browser tab or from the bot).
function clearViewerState() {
    mobs = [];
    mapData = null;
    botPos = { x: 0, y: 0 };
    botSpawned = false;
    connectedRegion = "";
    connectedBiome = "";
    mapSize = 100000;
    targetPos = null;
    botHp = null;
    botIsPinky = false;
    navPath = [];
    localNavPath = [];
    localNavPathTarget = null;
    lastBotPos = { x: 0, y: 0 };
    botHasNavigated = false;
    lastPetals = [];
    currentSession = -1; // accept any incoming session until next position
    document.getElementById("mob-count").textContent = "0";
    document.getElementById("map-name").textContent = "-";
    document.getElementById("biome-name").textContent = "-";
    document.getElementById("pos-grid-info").textContent = "pos: - | grid: -";
    const pinkyBadge = document.getElementById("pinky-badge");
    if (pinkyBadge) {
        pinkyBadge.textContent = "Pinky: -";
        pinkyBadge.className = "pinky-badge inactive";
    }
    equipListEl.innerHTML =
        '<div style="color:#6b7280;font-size:11px;text-align:center;padding:20px 10px;">切替中…</div>';
    drawMap();
}

// Right-click to cancel navigation
canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    targetPos = null;
    botHasNavigated = false;
    localNavPath = [];
    localNavPathTarget = null;
    drawMap();
    fetch("/navigate", { method: "DELETE" }).catch(() => {});
});

// Mouse wheel zoom
canvas.addEventListener(
    "wheel",
    (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const oldZoom = zoomLevel;
        zoomLevel *= e.deltaY < 0 ? 1.1 : 0.9;
        zoomLevel = Math.max(1.0, Math.min(5.0, zoomLevel));
        if (zoomLevel === 1.0) {
            panX = 0;
            panY = 0;
        } else {
            panX = mx - (mx - panX) * (zoomLevel / oldZoom);
            panY = my - (my - panY) * (zoomLevel / oldZoom);
        }
        drawMap();
    },
    { passive: false }
);

// Double-click to reset zoom
canvas.addEventListener("dblclick", () => {
    zoomLevel = 1.0;
    panX = 0;
    panY = 0;
    drawMap();
});

// Drag to pan
let _dragging = false;
let _dragMoved = false;
let _dragStartX = 0;
let _dragStartY = 0;
let _dragPanStartX = 0;
let _dragPanStartY = 0;
canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    // Route edit: check if clicking a waypoint
    if (routeEditMode && !routeRecording) {
        const rect = canvas.getBoundingClientRect();
        const [wx, wy] = canvasToGame(e.clientX - rect.left, e.clientY - rect.top);
        const cSize = mapSize / (mapData ? mapData.gridWidth : 1);
        for (let i = 0; i < routeCurrentWaypoints.length; i++) {
            const wp = routeCurrentWaypoints[i];
            const [sx, sy] = gameToCanvas(wp.x, wp.y);
            const dx = e.clientX - rect.left - sx;
            const dy = e.clientY - rect.top - sy;
            if (dx * dx + dy * dy < 100) {
                routeSelectedIdx = i;
                routeDragging = true;
                routeDragIdx = i;
                routePushHistory();
                drawMap();
                return;
            }
        }
        routeSelectedIdx = -1;
        drawMap();
    }
    _dragging = true;
    _dragMoved = false;
    _dragStartX = e.clientX;
    _dragStartY = e.clientY;
    _dragPanStartX = panX;
    _dragPanStartY = panY;
    canvas.style.cursor = "grabbing";
});
window.addEventListener("mousemove", (e) => {
    if (routeDragging && routeDragIdx >= 0) {
        const rect = canvas.getBoundingClientRect();
        const [wx, wy] = canvasToGame(e.clientX - rect.left, e.clientY - rect.top);
        const cSize = mapSize / (mapData ? mapData.gridWidth : 1);
        let cellX = Math.floor(wx / cSize);
        let cellY = Math.floor(wy / cSize);
        if (mapData && mapData.grid) {
            const rows = mapData.grid.length,
                cols = mapData.grid[0].length;
            cellX = Math.max(0, Math.min(cols - 1, cellX));
            cellY = Math.max(0, Math.min(rows - 1, cellY));
        }
        routeCurrentWaypoints[routeDragIdx] = { x: (cellX + 0.5) * cSize, y: (cellY + 0.5) * cSize };
        updateRouteStatus();
        drawMap();
        return;
    }
    if (!_dragging) return;
    const dx = e.clientX - _dragStartX;
    const dy = e.clientY - _dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) _dragMoved = true;
    panX = _dragPanStartX + dx;
    panY = _dragPanStartY + dy;
    drawMap();
});
window.addEventListener("mouseup", () => {
    if (routeDragging) {
        routeDragging = false;
        routeDragIdx = -1;
        return;
    }
    _dragging = false;
    canvas.style.cursor = "";
});

// Delete key: remove selected waypoint in edit mode
window.addEventListener("keydown", (e) => {
    if (e.key === "Delete" && routeEditMode && routeSelectedIdx >= 0) {
        routePushHistory();
        routeCurrentWaypoints.splice(routeSelectedIdx, 1);
        routeSelectedIdx = -1;
        updateRouteStatus();
        drawMap();
    }
});

// Biome mob list modal
let currentBiomeTab = null;

function openBiomeModal() {
    const overlay = document.getElementById("biome-modal-overlay");
    overlay.classList.add("active");
    if (Object.keys(BIOME_MOBS).length === 0) {
        // Config not loaded yet — fetch it first
        fetch("/config")
            .then((r) => (r.ok ? r.json() : null))
            .then((cfg) => {
                if (cfg && cfg.biomeMobs) {
                    applyConfig(cfg);
                    populateServerControls(cfg);
                }
                renderBiomeTabs();
                const biomes = Object.keys(BIOME_MOBS);
                if (biomes.length > 0) selectBiomeTab(biomes[0]);
            })
            .catch(() => {});
    } else {
        renderBiomeTabs();
        const biomes = Object.keys(BIOME_MOBS);
        if (biomes.length > 0) selectBiomeTab(biomes[0]);
    }
}

function closeBiomeModal() {
    document.getElementById("biome-modal-overlay").classList.remove("active");
}

function renderBiomeTabs() {
    const tabsEl = document.getElementById("biome-tabs");
    const biomes = Object.keys(BIOME_MOBS);
    tabsEl.innerHTML = biomes
        .map((b) => {
            const count = BIOME_MOBS[b].length;
            const active = b === currentBiomeTab ? " active" : "";
            // Find color from BIOME_COLORS if available
            return `<div class="biome-tab${active}" onclick="selectBiomeTab('${b}')">${b}<span class="mob-count-badge">${count}</span></div>`;
        })
        .join("");
}

function selectBiomeTab(biome) {
    // Save current tab's DOM state before switching (prevents data loss)
    if (document.querySelector(".track-toggle")) {
        saveTrackingConfig();
    }
    currentBiomeTab = biome;
    renderBiomeTabs();
    const listEl = document.getElementById("biome-mob-list");
    const slugs = BIOME_MOBS[biome] || [];
    if (slugs.length === 0) {
        listEl.innerHTML = '<div class="biome-mob-count">No mobs in this biome</div>';
        return;
    }
    const items = slugs.map((slug) => {
        const mob = MOB_BY_SLUG[slug];
        const name = mob ? mob.name : slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        return { name, slug };
    });
    items.sort((a, b) => a.name.localeCompare(b.name));

    const variantEntries = Object.entries(VARIANT_NAMES);
    const variantChecksHtml = variantEntries
        .map(
            ([id, vname]) =>
                `<label class="mob-checkbox-label"><input type="checkbox" class="mob-checkbox" data-type="var" data-id="${id}">${vname}</label>`
        )
        .join("");
    const rarityChecksHtml = RARITIES.map(
        (r, i) =>
            `<label class="mob-checkbox-label" style="color:${r.color}"><input type="checkbox" class="mob-checkbox" data-type="rar" data-id="${i}">${r.name}</label>`
    ).join("");

    listEl.innerHTML = `<div class="biome-mob-grid">
                <div class="biome-mob-col" id="mob-col-left"></div>
                <div class="biome-mob-col" id="mob-col-right"></div>
            </div>`;
    const colLeft = document.getElementById("mob-col-left");
    const colRight = document.getElementById("mob-col-right");
    items.forEach((item, i) => {
        const col = i % 2 === 0 ? colLeft : colRight;
        const div = document.createElement("div");
        div.className = "biome-mob-item";
        div.id = "mob-item-" + item.slug;
        div.innerHTML = `
                    <div class="biome-mob-row" onclick="toggleSubPanel('${item.slug}')">
                        <span>
                            <span class="mob-expand" id="mob-arrow-${item.slug}">&#9654;</span>
                            <span class="biome-mob-name">${item.name}</span>
                        </span>
                        <button class="track-toggle" id="track-btn-${item.slug}" onclick="event.stopPropagation();toggleTrack('${item.slug}')">OFF</button>
                    </div>
                    <div class="mob-sub-panel" id="mob-sub-${item.slug}">
                        <div class="mob-section-title">Variants
                            <button class="mob-all-btn" onclick="toggleAll('${item.slug}','var',true)">All</button>
                            <button class="mob-all-btn" onclick="toggleAll('${item.slug}','var',false)">None</button>
                        </div>
                        <div class="mob-checkbox-wrap" id="mob-vars-${item.slug}">${variantChecksHtml}</div>
                        <div class="mob-section-title">Rarities
                            <button class="mob-all-btn" onclick="toggleAll('${item.slug}','rar',true)">All</button>
                            <button class="mob-all-btn" onclick="toggleAll('${item.slug}','rar',false)">None</button>
                        </div>
                        <div class="mob-checkbox-wrap" id="mob-rars-${item.slug}">${rarityChecksHtml}</div>
                    </div>`;
        col.appendChild(div);
    });

    for (const item of items) {
        restoreTrackState(item.slug);
    }
}

// Tracking functions
let trackingConfig = { targets: [] };

function loadTrackingConfig() {
    fetch("/tracking/config")
        .then((r) => (r.ok ? r.json() : null))
        .then((cfg) => {
            if (cfg) {
                trackingConfig = cfg;
                if (currentBiomeTab) selectBiomeTab(currentBiomeTab);
            }
        })
        .catch(() => {});
}

function saveTrackingConfig() {
    // Start from existing targets (preserves mobs from other biome tabs
    // that are not currently in the DOM).
    const merged = new Map(trackingConfig.targets.map((t) => [t.slug, { ...t }]));
    // Overwrite with current DOM state
    document.querySelectorAll(".track-toggle").forEach((btn) => {
        const slug = btn.id.replace("track-btn-", "");
        const enabled = btn.classList.contains("active");
        const variants = [];
        const rarities = [];
        const varWrap = document.getElementById("mob-vars-" + slug);
        const rarWrap = document.getElementById("mob-rars-" + slug);
        if (varWrap) {
            varWrap.querySelectorAll("input:checked").forEach((cb) => variants.push(Number(cb.dataset.id)));
        }
        if (rarWrap) {
            rarWrap.querySelectorAll("input:checked").forEach((cb) => rarities.push(Number(cb.dataset.id)));
        }
        merged.set(slug, { slug, enabled, variants, rarities });
    });
    trackingConfig.targets = Array.from(merged.values());
    fetch("/tracking/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(trackingConfig),
    }).catch(() => {});
}

function toggleTrack(slug) {
    const btn = document.getElementById("track-btn-" + slug);
    if (!btn) return;
    btn.classList.toggle("active");
    btn.textContent = btn.classList.contains("active") ? "ON" : "OFF";
    saveTrackingConfig();
}

function toggleSubPanel(slug) {
    const panel = document.getElementById("mob-sub-" + slug);
    const arrow = document.getElementById("mob-arrow-" + slug);
    if (!panel) return;
    const open = panel.classList.toggle("open");
    if (arrow) arrow.classList.toggle("open", open);
}

function onCheckboxChange(slug) {
    saveTrackingConfig();
}

function toggleAll(slug, type, checked) {
    const wrapId = type === "var" ? "mob-vars-" + slug : "mob-rars-" + slug;
    const wrap = document.getElementById(wrapId);
    if (!wrap) return;
    wrap.querySelectorAll("input").forEach((cb) => (cb.checked = checked));
    saveTrackingConfig();
}

function restoreTrackState(slug) {
    const target = trackingConfig.targets.find((t) => t.slug === slug);
    const btn = document.getElementById("track-btn-" + slug);
    const isEnabled = target
        ? target.enabled !== undefined
            ? target.enabled
            : target.variants.length > 0 || target.rarities.length > 0
        : false;
    if (isEnabled) {
        if (btn) {
            btn.classList.add("active");
            btn.textContent = "ON";
        }
    } else {
        if (btn) {
            btn.classList.remove("active");
            btn.textContent = "OFF";
        }
    }
    if (!target) return;
    const varWrap = document.getElementById("mob-vars-" + slug);
    const rarWrap = document.getElementById("mob-rars-" + slug);
    if (varWrap) {
        varWrap.querySelectorAll("input").forEach((cb) => {
            cb.checked = target.variants.includes(Number(cb.dataset.id));
        });
    }
    if (rarWrap) {
        rarWrap.querySelectorAll("input").forEach((cb) => {
            cb.checked = target.rarities.includes(Number(cb.dataset.id));
        });
    }
}

// ━━━━━━ Ping Roles ━━━━━━
let pingRules = { rules: [] };
let pingSearchQuery = "";
let pingExpanded = false;
let roleCache = {};
let anyMobSelected = false;

function switchTrackingView(view) {
    document.querySelectorAll(".tracking-tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
    document.querySelectorAll(".tracking-view").forEach((v) => v.classList.toggle("active", v.id === view + "-view"));
    if (view === "ping") {
        initPingFilters();
        renderPingMobList();
        renderPingRules();
        loadRoles();
    } else if (view === "biomes") {
        renderBiomeChannels();
    }
}

function loadPingRules() {
    fetch("/ping-rules")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
            if (data) {
                pingRules = data;
                renderPingRules();
                renderPingMobList();
            }
        })
        .catch(() => {});
}

function saveAllConfig() {
    saveTrackingConfig();
    savePingRules();
    saveBiomeChannels();
}

function savePingRules() {
    const validRules = pingRules.rules.filter((r) => r.roleId);
    fetch("/ping-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: validRules }),
    }).catch(() => {});
}

function initPingFilters() {
    const varWrap = document.getElementById("ping-vars");
    const rarWrap = document.getElementById("ping-rars");
    if (!varWrap || !rarWrap) return;
    if (Object.keys(VARIANT_NAMES).length === 0) return;
    varWrap.innerHTML = Object.entries(VARIANT_NAMES)
        .map(
            ([id, name]) =>
                `<label class="mob-checkbox-label"><input type="checkbox" class="ping-checkbox" data-type="var" data-id="${id}">${name}</label>`
        )
        .join("");
    rarWrap.innerHTML = RARITIES.map(
        (r, i) =>
            `<label class="mob-checkbox-label" style="color:${r.color}"><input type="checkbox" class="ping-checkbox" data-type="rar" data-id="${i}">${r.name}</label>`
    ).join("");
}

function getFilteredMobSlugs() {
    const q = pingSearchQuery.toLowerCase();
    return Object.keys(MOB_BY_SLUG)
        .filter((s) => {
            const mob = MOB_BY_SLUG[s];
            const name = (mob?.name || s).toLowerCase();
            return name.includes(q) || s.includes(q);
        })
        .sort((a, b) => {
            const na = (MOB_BY_SLUG[a]?.name || a).toLowerCase();
            const nb = (MOB_BY_SLUG[b]?.name || b).toLowerCase();
            return na.localeCompare(nb);
        });
}

function renderPingMobList() {
    const el = document.getElementById("ping-mob-list");
    const countEl = document.getElementById("ping-mob-count");
    const moreBtn = document.getElementById("ping-mob-more");
    if (!el) return;
    const allSlugs = getFilteredMobSlugs();
    const show = pingExpanded ? allSlugs : allSlugs.slice(0, 20);
    const anyDisabled = "";
    countEl && (countEl.textContent = `${show.length} / ${allSlugs.length} mobs`);
    if (moreBtn) {
        if (allSlugs.length <= 20) {
            moreBtn.style.display = "none";
        } else {
            moreBtn.style.display = "block";
            moreBtn.textContent = pingExpanded ? "Show Less" : `Show All (${allSlugs.length} mobs)`;
        }
    }
    const anyChecked = anyMobSelected ? " checked" : "";
    let html = `<label class="ping-mob-label ping-mob-any"><input type="checkbox" class="ping-mob-checkbox" data-slug=""${anyChecked}${anyDisabled}> (Any Mob - variant/rarity only)</label>`;

    html += show
        .map((slug) => {
            const mob = MOB_BY_SLUG[slug];
            const name = (mob?.name || slug).replace(/_/g, " ");
            return `<label class="ping-mob-label"><input type="checkbox" class="ping-mob-checkbox" data-slug="${slug}"> ${name}</label>`;
        })
        .join("");
    el.innerHTML = html;
}

function onPingMobSearch() {
    pingSearchQuery = document.getElementById("ping-mob-search").value;
    pingExpanded = false;
    renderPingMobList();
}

function loadMoreMobs() {
    pingExpanded = !pingExpanded;
    renderPingMobList();
}

function togglePingAll(type, checked) {
    const wrap = document.getElementById(type === "var" ? "ping-vars" : "ping-rars");
    if (wrap) wrap.querySelectorAll("input").forEach((cb) => (cb.checked = checked));
}

function addPingRule() {
    const checkedSlugs = [];
    document.querySelectorAll("#ping-mob-list .ping-mob-checkbox:checked").forEach((cb) => {
        if (cb.dataset.slug !== "") checkedSlugs.push(cb.dataset.slug);
    });
    const anyCheckbox = document.querySelector('#ping-mob-list .ping-mob-checkbox[data-slug=""]');
    if (anyCheckbox && anyCheckbox.checked) {
        checkedSlugs.push("");
    }
    const roleId = document.getElementById("ping-role-id-input").value.trim();
    if (checkedSlugs.length === 0 || !roleId) return;
    const variants = [];
    const rarities = [];
    document
        .querySelectorAll("#ping-vars .ping-checkbox:checked")
        .forEach((cb) => variants.push(Number(cb.dataset.id)));
    document
        .querySelectorAll("#ping-rars .ping-checkbox:checked")
        .forEach((cb) => rarities.push(Number(cb.dataset.id)));
    for (const slug of checkedSlugs) {
        if (slug === "") {
            pingRules.rules = pingRules.rules.filter((r) => r.slug !== "" || r.roleId);
        }
        const dup = pingRules.rules.some((r) => r.slug === slug && r.roleId === roleId);
        if (!dup) {
            pingRules.rules.push({ slug, variants, rarities, roleId });
        }
    }
    renderPingRules();
    anyMobSelected = false;
    renderPingMobList();
    document.getElementById("ping-role-id-input").value = "";
    document.querySelectorAll(".ping-checkbox").forEach((cb) => (cb.checked = false));
}

function deletePingRule(index) {
    pingRules.rules.splice(index, 1);
    renderPingRules();
    renderPingMobList();
}

function loadRoles() {
    fetch("/api/roles")
        .then((r) => (r.ok ? r.json() : null))
        .then((roles) => {
            if (roles && Array.isArray(roles)) {
                roleCache = {};
                roles.forEach((r) => {
                    roleCache[r.id] = r.name;
                });
                renderPingRules();
            }
        })
        .catch(() => {});
}

function renderPingRules() {
    const el = document.getElementById("ping-rules-list");
    if (!el) return;
    if (!pingRules.rules || pingRules.rules.length === 0) {
        el.innerHTML =
            '<div style="color:#6b7280;font-size:11px;text-align:center;padding:8px;">No ping rules configured</div>';
        return;
    }
    el.innerHTML = pingRules.rules
        .map((rule, i) => {
            const mobName = rule.slug ? (MOB_BY_SLUG[rule.slug]?.name || rule.slug).replace(/_/g, " ") : "(Any Mob)";
            const varText =
                rule.variants && rule.variants.length > 0
                    ? "v:" + rule.variants.map((v) => VARIANT_NAMES[v] || `V${v}`).join(",")
                    : "all variants";
            const rarText =
                rule.rarities && rule.rarities.length > 0
                    ? "r:" + rule.rarities.map((r) => RARITIES[r]?.name || `R${r}`).join(",")
                    : "all rarities";
            const roleName = roleCache[rule.roleId];
            const roleDisplay = roleName ? `@${roleName} (${rule.roleId})` : `@&amp;${rule.roleId}`;
            return `<div class="ping-rule-item">
                    <div class="ping-rule-info">
                        <div><span class="ping-rule-slug">${mobName}</span> → <span class="ping-role-id">${roleDisplay}</span></div>
                        <div class="ping-rule-filters">${varText} · ${rarText}</div>
                    </div>
                    <button class="ping-del-btn" onclick="deletePingRule(${i})">Del</button>
                </div>`;
        })
        .join("");
}

// ━━━━━━ Biome Channels ━━━━━━
let biomeChannels = { defaultChannelId: "", biomes: {} };

function loadBiomeChannels() {
    fetch("/biome-channels")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
            if (data) {
                biomeChannels = data;
                renderBiomeChannels();
            }
        })
        .catch(() => {});
}

function saveBiomeChannels() {
    // Collect from DOM
    biomeChannels.defaultChannelId = document.getElementById("biome-default-channel").value.trim();
    const entries = {};
    document.querySelectorAll("#biome-channel-list .bio-channel-input").forEach((inp) => {
        const slug = inp.dataset.slug;
        const val = inp.value.trim();
        if (val) entries[slug] = val;
    });
    biomeChannels.biomes = entries;
    fetch("/biome-channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(biomeChannels),
    }).catch(() => {});
}

function renderBiomeChannels() {
    const el = document.getElementById("biome-channel-list");
    const defInput = document.getElementById("biome-default-channel");
    if (!el || !defInput) return;
    defInput.value = biomeChannels.defaultChannelId || "";
    if (CONFIG_BIOMES.length === 0) {
        el.innerHTML =
            '<div style="color:#6b7280;font-size:11px;text-align:center;padding:12px;">Load game config first</div>';
        return;
    }
    el.innerHTML = CONFIG_BIOMES.map((b) => {
        const val = (biomeChannels.biomes && biomeChannels.biomes[b.slug]) || "";
        return `<div class="ping-rule-item">
                    <span style="color:#00ffcc;font-weight:bold;font-size:11px;min-width:80px;">${b.name}</span>
                    <input type="text" class="bio-channel-input" data-slug="${b.slug}" value="${val}" placeholder="Channel ID" style="flex:1;background:#1a1f2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:11px;font-family:monospace;padding:4px 6px;outline:none;" />
                </div>`;
    }).join("");
}

// Delegate checkbox change events
document.addEventListener("change", (e) => {
    // Any Mob toggle → add/remove uncommitted placeholder
    if (e.target.classList.contains("ping-mob-checkbox") && e.target.dataset.slug === "") {
        const checked = e.target.checked;
        anyMobSelected = checked;
        if (checked) {
            if (!pingRules.rules.some((r) => !r.slug)) {
                pingRules.rules.push({ slug: "", variants: [], rarities: [] });
            }
        } else {
            pingRules.rules = pingRules.rules.filter((r) => r.slug !== "" || r.roleId);
        }
        renderPingMobList();
        return;
    }
    // Tracking config checkbox change
    if (e.target.classList.contains("mob-checkbox")) {
        const item = e.target.closest(".biome-mob-item");
        if (item) {
            const slug = item.id.replace("mob-item-", "");
            onCheckboxChange(slug);
        }
    }
});

// Load tracking config + ping rules + biome channels on startup
loadTrackingConfig();
loadPingRules();
loadBiomeChannels();

// Re-render ping mob list + init filters + biome channels when config loads
const _origApplyConfig = applyConfig;
applyConfig = function (cfg) {
    _origApplyConfig(cfg);
    initPingFilters();
    renderPingMobList();
    renderBiomeChannels();
};

// Restore auto-patrol state on page load
fetch("/auto-patrol/status")
    .then((r) => r.json())
    .then((data) => {
        if (!data) return;
        for (const [id, apData] of Object.entries(data)) {
            if (accounts[id]) accounts[id].ap = apData;
        }
        renderAccountList();
        if (selectedAccountId && data[selectedAccountId]) {
            updateAutoPatrolUI(data[selectedAccountId]);
        }
    })
    .catch(() => {});

// === Route Recorder ===
let customRoutes = {};
let routeRecording = false;
let routeCurrentKey = "";
let routeCurrentWaypoints = [];
let routeHistory = [];
let routeRedoStack = [];
let routePlaying = false;
// === Route Edit Mode ===
let routeEditMode = false;
let routeEditKey = "";
let routeSelectedIdx = -1;
let routeDragging = false;
let routeDragIdx = -1;

function getRouteMapKey() {
    const mn = document.getElementById("map-name")?.textContent || "";
    const bn = document.getElementById("biome-name")?.textContent || "";
    if (!mn || mn === "-") return "";
    return `${bn}-${mn.replace(/_g\d+x\d+$/, "")}`;
}

function loadRoutes() {
    fetch("/routes")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
            if (data) {
                customRoutes = data;
                rebuildRouteDirectory();
            }
        })
        .catch(() => {});
}

function saveRoute(key, waypoints) {
    fetch("/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, waypoints }),
    })
        .then(() => rebuildRouteDirectory())
        .catch(() => {});
}

function deleteRoute(key) {
    fetch(`/routes/${encodeURIComponent(key)}`, { method: "DELETE" })
        .then(() => {
            delete customRoutes[key];
            rebuildRouteDirectory();
        })
        .catch(() => {});
}

function toggleRoutePanel() {
    document.getElementById("route-panel").classList.toggle("open");
}

function toggleRecording() {
    const btn = document.getElementById("route-rec-btn");
    if (!routeRecording) {
        const key = getRouteMapKey();
        if (!key) return;
        routeRecording = true;
        routeCurrentKey = key;
        routeCurrentWaypoints = customRoutes[key] ? [...customRoutes[key]] : [];
        routeHistory = [];
        routeRedoStack = [];
        btn.textContent = "Stop Rec";
        btn.classList.add("recording");
    } else {
        if (routeCurrentKey) {
            customRoutes[routeCurrentKey] = [...routeCurrentWaypoints];
            saveRoute(routeCurrentKey, routeCurrentWaypoints);
        }
        routeRecording = false;
        btn.textContent = "Record";
        btn.classList.remove("recording");
    }
    updateRouteStatus();
}

function routePushHistory() {
    routeHistory.push(JSON.parse(JSON.stringify(routeCurrentWaypoints)));
    if (routeHistory.length > 50) routeHistory.shift();
    routeRedoStack = [];
    updateRouteButtons();
}

function routeUndo() {
    if (routeHistory.length === 0) return;
    routeRedoStack.push(JSON.parse(JSON.stringify(routeCurrentWaypoints)));
    routeCurrentWaypoints = routeHistory.pop();
    updateRouteStatus();
    updateRouteButtons();
}

function routeRedo() {
    if (routeRedoStack.length === 0) return;
    routeHistory.push(JSON.parse(JSON.stringify(routeCurrentWaypoints)));
    routeCurrentWaypoints = routeRedoStack.pop();
    updateRouteStatus();
    updateRouteButtons();
}

function routeClear() {
    const key = routeRecording ? routeCurrentKey : getRouteMapKey();
    if (!key) return;
    if (routeRecording) {
        routePushHistory();
        routeCurrentWaypoints = [];
    } else {
        deleteRoute(key);
    }
    updateRouteStatus();
}

// === Route Edit Mode ===
function startRouteEdit() {
    const key = getRouteMapKey();
    if (!key || !customRoutes[key]) return;
    if (routeRecording) return;
    routeEditMode = true;
    routeEditKey = key;
    routeCurrentKey = key;
    routeCurrentWaypoints = JSON.parse(JSON.stringify(customRoutes[key]));
    routeSelectedIdx = -1;
    routeHistory = [];
    routeRedoStack = [];
    updateRouteStatus();
    updateRouteButtons();
    drawMap();
}

function stopRouteEdit(save) {
    if (!routeEditMode) return;
    if (save && routeEditKey) {
        customRoutes[routeEditKey] = [...routeCurrentWaypoints];
        saveRoute(routeEditKey, routeCurrentWaypoints);
    }
    routeEditMode = false;
    routeEditKey = "";
    routeSelectedIdx = -1;
    routeDragging = false;
    routeDragIdx = -1;
    routeCurrentWaypoints = [];
    updateRouteStatus();
    updateRouteButtons();
    drawMap();
}

function saveCurrentRoute() {
    if (routeEditMode) {
        stopRouteEdit(true);
    } else {
        const key = getRouteMapKey();
        if (key && customRoutes[key]) {
            saveRoute(key, customRoutes[key]);
        }
    }
}

function updateRouteStatus() {
    const key = routeEditMode ? routeEditKey : routeRecording ? routeCurrentKey : getRouteMapKey();
    const keyEl = document.getElementById("route-map-key");
    const countEl = document.getElementById("route-wp-count");
    if (!keyEl || !countEl) return;
    keyEl.textContent = key || "-";
    const count = routeRecording || routeEditMode ? routeCurrentWaypoints.length : (customRoutes[key] || []).length;
    countEl.textContent = count;
    updateRouteButtons();
}

function updateRouteButtons() {
    const undoEl = document.getElementById("route-undo-btn");
    const redoEl = document.getElementById("route-redo-btn");
    if (undoEl) undoEl.disabled = routeHistory.length === 0;
    if (redoEl) redoEl.disabled = routeRedoStack.length === 0;

    const editControls = document.getElementById("route-edit-controls");
    const editBtn = document.getElementById("route-edit-btn");
    const saveBtn = document.getElementById("route-save-btn");
    const cancelBtn = document.getElementById("route-cancel-btn");
    if (!editControls) return;

    if (routeRecording) {
        editControls.style.display = "none";
    } else if (routeEditMode) {
        editControls.style.display = "";
        if (editBtn) editBtn.style.display = "none";
        if (saveBtn) saveBtn.style.display = "";
        if (cancelBtn) cancelBtn.style.display = "";
    } else {
        const key = getRouteMapKey();
        const hasRoute = key && customRoutes[key] && customRoutes[key].length > 0;
        editControls.style.display = hasRoute ? "" : "none";
        if (editBtn) editBtn.style.display = "";
        if (saveBtn) saveBtn.style.display = "none";
        if (cancelBtn) cancelBtn.style.display = "none";
    }
}

function biomeSortKey(key) {
    const biome = key.split("-")[0] || "";
    if (currentServerBiomeName && biome === currentServerBiomeName) return -1;
    return 0;
}

function rebuildRouteDirectory() {
    const el = document.getElementById("route-directory");
    if (!el) return;
    const activeKey = getRouteMapKey();
    const keys = Object.keys(customRoutes).sort((a, b) => {
        const da = biomeSortKey(a),
            db = biomeSortKey(b);
        if (da !== db) return da - db;
        return a.localeCompare(b);
    });
    el.innerHTML = keys
        .map((k) => {
            const pts = customRoutes[k];
            const isActive = k === activeKey;
            const cls = isActive ? "active" : "inactive";
            const click = isActive ? `onclick="previewRoute('${k.replace(/'/g, "\\'")}')"` : "";
            return `<div class="route-dir-item ${cls}" ${click}>
                    <span class="route-dir-name">${k}</span>
                    <span class="route-dir-pts">${pts.length}pts</span>
                    ${isActive ? `<span class="route-dir-del" onclick="event.stopPropagation();deleteRoute('${k.replace(/'/g, "\\'")}')">&#128465;</span>` : ""}
                </div>`;
        })
        .join("");
    updateRouteButtons();
}

function previewRoute(key) {
    if (key !== getRouteMapKey()) return;
    routePreviewKey = key;
    updateRouteButtons();
    drawMap();
}
let routePreviewKey = null;

function playRoute() {
    const key = routeRecording ? routeCurrentKey : getRouteMapKey();
    const waypoints = routeRecording ? routeCurrentWaypoints : customRoutes[key];
    if (!waypoints || waypoints.length === 0) return;
    routePlaying = true;
    fetch("/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "patrol", route: waypoints }),
    }).catch(() => {});
    document.getElementById("route-play-btn").classList.add("playing");
}

function stopRoute() {
    routePlaying = false;
    fetch("/navigate", { method: "DELETE" }).catch(() => {});
    document.getElementById("route-play-btn").classList.remove("playing");
}

// Canvas click handler for route recording
// Corridor centering: offset waypoints to the middle of the corridor,
// equidistant from both walls.
function corridorCenter(cell, grid, rows, cols) {
    const [cx, cy] = cell;
    let up = cy,
        down = cy,
        left = cx,
        right = cx;
    while (up > 0 && grid[up - 1][cx] === 1) up--;
    while (down < rows - 1 && grid[down + 1][cx] === 1) down++;
    while (left > 0 && grid[cy][left - 1] === 1) left--;
    while (right < cols - 1 && grid[cy][right + 1] === 1) right++;
    return [(left + right) / 2, (up + down) / 2];
}

function centerPath(path, grid) {
    if (path.length <= 2) return path;
    const rows = grid.length,
        cols = grid[0].length;
    const result = [path[0]];
    for (let i = 1; i < path.length - 1; i++) {
        const prev = path[i - 1],
            curr = path[i],
            next = path[i + 1];
        const dx1 = curr[0] - prev[0],
            dy1 = curr[1] - prev[1];
        const dx2 = next[0] - curr[0],
            dy2 = next[1] - curr[1];
        if (dx1 === dx2 && dy1 === dy2) {
            const [ccx, ccy] = corridorCenter(curr, grid, rows, cols);
            if (dx1 !== 0) result.push([curr[0], ccy]);
            else result.push([ccx, curr[1]]);
        } else {
            const [ccx, ccy] = corridorCenter(curr, grid, rows, cols);
            result.push([ccx, ccy]);
        }
    }
    result.push(path[path.length - 1]);
    return result;
}

canvas.addEventListener("click", (e) => {
    if (!routeRecording) return;
    if (_dragMoved) return;
    if (!mapData || !mapData.grid || !mapData.gridWidth || !mapData.mapSize) {
        console.log("[Route] No mapData, skip");
        return;
    }

    const [worldX, worldY] = canvasToGame(
        e.clientX - e.target.getBoundingClientRect().left,
        e.clientY - e.target.getBoundingClientRect().top
    );

    const cSize = mapData.mapSize / mapData.gridWidth;
    const grid = mapData.grid;
    const rows = grid.length,
        cols = grid[0].length;

    // Clicked cell
    let cellX = Math.floor(worldX / cSize);
    let cellY = Math.floor(worldY / cSize);
    cellX = Math.max(0, Math.min(cols - 1, cellX));
    cellY = Math.max(0, Math.min(rows - 1, cellY));
    console.log(`[Route] Click cell: (${cellX},${cellY}) grid=${grid[cellY]?.[cellX]}`);

    // Wall-snap: clicked cell is wall → BFS outward to find nearest walkable
    if (grid[cellY][cellX] === 0) {
        let found = false;
        for (let ring = 1; ring < Math.max(rows, cols) && !found; ring++) {
            for (let dy = -ring; dy <= ring && !found; dy++) {
                for (let dx = -ring; dx <= ring && !found; dx++) {
                    if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
                    const ny = cellY + dy,
                        nx = cellX + dx;
                    if (ny >= 0 && ny < rows && nx >= 0 && nx < cols && grid[ny][nx] === 1) {
                        cellX = nx;
                        cellY = ny;
                        found = true;
                    }
                }
            }
        }
        if (!found) {
            console.log("[Route] No walkable cell found");
            return;
        }
        console.log(`[Route] Wall-snapped to (${cellX},${cellY})`);
    }

    // Snap to cell center (world coords)
    const snapX = (cellX + 0.5) * cSize;
    const snapY = (cellY + 0.5) * cSize;

    routePushHistory();

    // A* auto-connect (skip start/end from centerPath output)
    if (routeCurrentWaypoints.length > 0) {
        const last = routeCurrentWaypoints[routeCurrentWaypoints.length - 1];
        console.log(`[Route] A* from (${last.x},${last.y}) to (${snapX},${snapY})`);
        const path = findPathLocal(last.x, last.y, snapX, snapY, grid, mapData.gridWidth, mapData.mapSize);
        console.log(`[Route] A* result: ${path ? path.length : "null"} points`);
        if (path && path.length > 1) {
            const cSize = mapData.mapSize / mapData.gridWidth;
            for (let i = 1; i < path.length; i++) {
                routeCurrentWaypoints.push({
                    x: (path[i][0] + 0.5) * cSize,
                    y: (path[i][1] + 0.5) * cSize,
                });
            }
        }
    }

    // Always add the snapped point
    routeCurrentWaypoints.push({ x: snapX, y: snapY });
    console.log(`[Route] Total waypoints: ${routeCurrentWaypoints.length}`);
    updateRouteStatus();
    drawMap();
});

loadRoutes();
updateRouteStatus();

window.addEventListener("resize", resizeCanvas);
resizeCanvas();
