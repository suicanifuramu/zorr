import path from "node:path";
import http from "node:http";
import fs from "node:fs";
import WebSocket from "ws";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { fileURLToPath } from "node:url";
import {
    OPCODE_SEND,
    SHOW_OTHER_PETS_OPCODE,
    BUILD_MAGIC,
    BUILD_AX,
    ENTITY_TYPE,
    UPDATE_FLAGS,
    CENTER_COST,
    _CONTROL_BACKOFF_INITIAL_MS,
    _CONTROL_BACKOFF_MAX_MS,
    _FRANTIC_DIRS,
    _FRANTIC_MAX_MS,
    talentSlugToId,
    LCG,
    MinHeap,
    decodeItemValue,
    decompressCoord,
    readString,
    decodeStatusFlags,
    getPrintableAscii,
    buildDistanceMap,
    decodeBuildCode,
} from "./lib/bot/protocol.js";
import { BotRenderable } from "./lib/bot/rendering.js";
import { BotNavigable } from "./lib/bot/navigation.js";
import { BotAutopatrol } from "./lib/bot/autopatrol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAP_SERVER_URL = "http://localhost:3000";

class BotSession {
    constructor(accountId, sharedData, botName, buildNumber = null, proxyUrl = null) {
        this.accountId = accountId;
        this._buildNumber = buildNumber;
        this.proxyUrl = proxyUrl;
        this.proxyAgent = null;
        if (proxyUrl) {
            try {
                if (proxyUrl.startsWith("socks")) {
                    this.proxyAgent = new SocksProxyAgent(proxyUrl);
                } else if (proxyUrl.startsWith("http")) {
                    this.proxyAgent = new HttpsProxyAgent(proxyUrl);
                }
            } catch (e) {
                console.log(`[${this.accountId.slice(0, 8)}] [Proxy] Agent creation failed: ${e.message}`);
            }
        }
        this.botName = botName || "";
        this.serverUrl = "wss://s-us-plains.zorr.pro/";

        // Shared read-only data
        this._petalNames = sharedData.petalNames;
        this._slugToId = sharedData.slugToId;
        this._mobNames = sharedData.mobNames;
        this._mobSlugs = sharedData.mobSlugs;
        this._snakeMobIndices = sharedData.snakeMobIndices;
        this._rarities = sharedData.rarities;
        this._variants = sharedData.variants || [];
        this._variantNames = this._variants.map((v) => v.name);
        this._PINKY_BITMASK = sharedData.PINKY_BITMASK;
        this._protocolVersion = sharedData.protocolVersion;

        // Connection
        this.ws = null;
        this._switching = false;
        this._switchingTimer = null;
        this._lastWsMessageAt = 0;
        this._lastMapBroadcast = 0;
        this._connectEpoch = 0;
        this._connectCounter = 0;
        this._currentSessionId = 0;
        this.encryptor = null;
        this.lcgBytesSent = 0;
        this.equipSentTime = null;

        // Bot state
        this.botId = null;
        this.botX = 0;
        this.botY = 0;
        this.botStats = null;
        this.activePetals = new Map();
        this.botEquippedPetals = [];
        this.botEquippedTalents = [];
        this.botInventory = {};
        this.isSpawned = false;
        this.isPinky = false;
        this.isDead = false;
        this.respawnState = "";
        this.returnToTitle = false;
        this.loggedIn = false;
        this.spawnSent = false;
        this.receivedOpcodes = new Set();
        this.streakData = { count: 0, lastClaimTime: 0, nextClaimDeadline: 0 };

        // Intervals
        this.pingInterval = null;
        this.movementInterval = null;
        this.pollInterval = null;

        // Map
        this.mapName = "";
        this.biomeName = "";
        this.gridWidth = 0;
        this.mapGrid = null;
        this.cellSize = 500;
        this.serverMapSize = 100000;
        this._distanceMap = null;

        // Entities
        this.knownEntities = new Map();
        this.activeMobs = new Map();
        this.botOutlierCount = 0;

        // Navigation
        this.navigateTarget = null;
        this.navPath = [];
        this.navWaypointIndex = 0;
        this.navRoute = [];
        this.navRouteIndex = 0;
        this.lastComputeCell = null;
        this._navWarned = { noGrid: false, oob: false, allWalls: false, noPath: false };

        // Stuck detection
        this._stuckCellKey = null;
        this._stuckSince = 0;
        this._franticMode = false;
        this._franticStartedAt = 0;
        this._franticOriginCX = 0;
        this._franticOriginCY = 0;
        this._franticDirIndex = 0;
        this._franticDirEnd = 0;
        this._corruptInvert = false;
        this._mobBlockDefending = false;
        this._mobBlockDetouring = false;
        this._mobBlockDefendUntil = 0;
        this._mobBlockWPKey = "";

        // Auto patrol
        this._AP = {
            active: false,
            state: "idle",
            pinkyFailCount: 0,
            pinkyTimeout: null,
            servers: [],
            serverIndex: 0,
            buildSwitchTimeout: null,
            cooldownTimer: null,
            patrolTimeout: null,
            log: [],
            routes: {},
        };

        // Server toggles
        this.serverAttackToggled = false;
        this.serverDefendToggled = false;

        // Equip pending
        this._pendingEquipCmd = null;
        this._pendingEquipRetryTimer = null;

        // SSE control stream
        this._controlStreamReq = null;
        this._controlStreamReconnectTimer = null;
        this._controlStreamConnected = false;
        this._controlStreamBackoffMs = _CONTROL_BACKOFF_INITIAL_MS;

        // Tracking
        this.trackingTargets = [];
        this.botToken = process.env.DISCORD_BOT_TOKEN || "";
        this.biomeChannels = { defaultChannelId: "", biomes: {} };
        this.notifiedMobs = [];
        this.pingRules = [];

        // Broadcast
        this._broadcastBuffer = {};
        this._broadcastTimer = null;
        this._broadcastDown = false;
    }

    // ── Build file resolution ──
    _resolveBuildPath(baseName) {
        if (this._buildNumber) {
            const numberedPath = path.join(__dirname, `loadouts/${baseName}${this._buildNumber}.txt`);
            if (fs.existsSync(numberedPath)) return numberedPath;
        }
        return path.join(__dirname, `loadouts/${baseName}.txt`);
    }

    // ── Connection ──
    _bumpGeneration() {
        this._connectCounter = (this._connectCounter + 1) % 10;
        if (this._connectCounter === 0) this._connectEpoch++;
    }

    start(assignedServers) {
        this._connectControlStream();
        this.connect();
        if (assignedServers && assignedServers.length > 0) {
            this._assignedServers = assignedServers;
        }
    }

    stop() {
        if (this.movementInterval) clearInterval(this.movementInterval);
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this._controlStreamReq) {
            try {
                this._controlStreamReq.destroy();
            } catch (e) {}
        }
        if (this.ws) {
            try {
                this.ws.close();
            } catch (e) {}
        }
    }

    connect() {
        this._bumpGeneration();
        this._currentSessionId++;
        const myEpoch = this._connectEpoch;
        const myCounter = this._connectCounter;
        const tag = `[${this.accountId.slice(0, 8)}]`;
        console.log(`${tag} [Bot] Connecting to ${this.serverUrl}... (gen=${myEpoch}:${myCounter})`);
        const wsOptions = {
            origin: "https://zorr.pro",
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        };
        if (this.proxyAgent) {
            wsOptions.agent = this.proxyAgent;
            console.log(`${tag} [Bot] Using proxy: ${this.proxyUrl}`);
        }
        this.ws = new WebSocket(this.serverUrl, /** @type {any} */ (wsOptions));
        this.ws.on("open", () => {
            this._sendHandshake();
        });
        this.ws.on("message", (data) => {
            this._handleMessage(new Uint8Array(data));
        });
        this.ws.on("close", (code, reason) => {
            if (myEpoch !== this._connectEpoch || myCounter !== this._connectCounter) return;
            if (this._AP.state === "cooldown") return;
            const tag2 = `[${this.accountId.slice(0, 8)}]`;
            console.log(`${tag2} [Bot] Connection closed (${code}). Reconnecting in 5s...`);
            const wasAPActive = this._AP.active;
            if (this._AP.active && this._AP.state !== "idle" && this._AP.state !== "next_server") {
                console.log(`${tag2} [Bot] AP state was '${this._AP.state}', resetting to 'next_server'`);
                this._AP.state = "next_server";
            }
            this._cleanup();
            setTimeout(() => {
                this.connect();
                if (wasAPActive && this._AP.active && this._AP.state === "next_server") {
                    const tag3 = `[${this.accountId.slice(0, 8)}]`;
                    console.log(`${tag3} [AP] Resuming after reconnect, advancing`);
                    this.apAdvance();
                }
            }, 5000);
        });
        this.ws.on("error", (err) => {
            console.error(`[${this.accountId.slice(0, 8)}] [Bot] WS Error: ${err.message}`);
        });
    }

    _cleanup() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.movementInterval) clearInterval(this.movementInterval);
        if (this.pollInterval) clearInterval(this.pollInterval);
        this.pingInterval = null;
        this.movementInterval = null;
        this.pollInterval = null;
        this.isSpawned = false;
        this.loggedIn = false;
        this.spawnSent = false;
        this.isDead = false;
        this.respawnState = "";
        this.isPinky = false;
        this.botOutlierCount = 0;
        if (this._pendingEquipRetryTimer) {
            clearTimeout(this._pendingEquipRetryTimer);
            this._pendingEquipRetryTimer = null;
        }
        this._pendingEquipCmd = null;
        this.receivedOpcodes = new Set();
        this.botId = null;
        this.botX = 0;
        this.botY = 0;
        this.botStats = null;
        this.activePetals.clear();
        this.activeMobs.clear();
        this.knownEntities.clear();
        this.botOutlierCount = 0;
        this.botEquippedPetals = [];
        this.botInventory = {};
        this.notifiedMobs.length = 0;
        this._clearNavigation("cleanup");
    }

    switchBotServer(region, biome) {
        if (this._switching) return;
        this.notifiedMobs.length = 0;
        this._switching = true;
        this._clearNavigation("switch");
        const tag = `[${this.accountId.slice(0, 8)}]`;
        if (this._switchingTimer) clearTimeout(this._switchingTimer);
        this._switchingTimer = setTimeout(() => {
            if (this._switching) {
                this._switching = false;
                console.log(`${tag} [Switch] Force reset _switching after 15s timeout`);
                if (this._AP.active && this._AP.state !== "idle" && this._AP.state !== "cooldown") {
                    console.log(`${tag} [AP] Recovering from stuck switch, advancing to next server`);
                    this._AP.serverIndex++;
                    this.apAdvance();
                }
            }
        }, 15000);
        try {
            const postData = JSON.stringify({ type: "switch", accountId: this.accountId, region, biome });
            http.request(
                {
                    hostname: "localhost",
                    port: 3000,
                    path: "/mapdata",
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
                },
                (res) => {
                    res.resume();
                }
            )
                .on("error", () => {})
                .end(postData);
        } catch (_) {}
        for (const type of Object.keys(this._broadcastBuffer)) delete this._broadcastBuffer[type];
        if (this._broadcastTimer) {
            clearTimeout(this._broadcastTimer);
            this._broadcastTimer = null;
        }
        const newUrl = `wss://s-${region}-${biome}.zorr.pro/`;
        console.log(`${tag} [Switch] ${this.serverUrl} -> ${newUrl}`);
        this.serverUrl = newUrl;
        this._bumpGeneration();
        const oldWs = this.ws;
        if (oldWs) {
            let reconnected = false;
            const onClosed = () => {
                if (reconnected) return;
                reconnected = true;
                if (this._switchingTimer) {
                    clearTimeout(this._switchingTimer);
                    this._switchingTimer = null;
                }
                this._cleanup();
                setTimeout(() => {
                    this._switching = false;
                    this.connect();
                }, 1000);
            };
            oldWs.once("close", onClosed);
            try {
                oldWs.close();
            } catch (_) {
                onClosed();
            }
        } else {
            if (this._switchingTimer) {
                clearTimeout(this._switchingTimer);
                this._switchingTimer = null;
            }
            this._switching = false;
            this.connect();
        }
    }

    // ── Send functions ──
    _sendEncrypted(packet) {
        if (!this.encryptor || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const encrypted = new Uint8Array(packet.length);
        for (let i = 0; i < packet.length; i++) encrypted[i] = packet[i] ^ this.encryptor.next();
        this.ws.send(encrypted);
        this.lcgBytesSent += packet.length;
    }

    _sendHandshake() {
        const seed = Math.floor(Math.random() * 4294967296);
        this.encryptor = new LCG(seed);
        const playerIdBytes = Buffer.from(this.accountId, "ascii");
        const packetSize = 1 + 4 + 4 + 20 + playerIdBytes.length;
        const packet = new Uint8Array(packetSize);
        const view = new DataView(packet.buffer);
        let y = 0;
        view.setUint8(y++, OPCODE_SEND.HANDSHAKE);
        view.setUint32(y, this._protocolVersion);
        y += 4;
        view.setUint32(y, seed);
        y += 4;
        for (let i = 0; i < 20; i++) view.setUint8(y++, this.encryptor.next());
        packet.set(playerIdBytes, y);
        this.ws.send(packet);
        const tag = `[${this.accountId.slice(0, 8)}]`;
        const headerBytes = packet.slice(0, 9);
        const headerHex = Array.from(headerBytes)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(" ");
        console.log(
            `${tag} [Handshake] Sent. Size: ${packet.length} bytes, protocol=${this._protocolVersion}, playerIdLen=${playerIdBytes.length}, header=[${headerHex}]`
        );
    }

    _sendPing() {
        this._sendEncrypted(new Uint8Array([OPCODE_SEND.PING, 0]));
    }
    _sendSpawn(name) {
        const nameBytes = Buffer.from(name || "", "utf-8");
        const packet = new Uint8Array(1 + nameBytes.length);
        packet[0] = OPCODE_SEND.SPAWN_PLAY;
        packet.set(nameBytes, 1);
        this._sendEncrypted(packet);
    }
    _sendShowOtherPets(enabled) {
        // Sending [122, 0] turns off "Show Other Pets".
        this._sendEncrypted(new Uint8Array([SHOW_OTHER_PETS_OPCODE, enabled ? 1 : 0]));
    }
    _sendDie() {
        this._sendEncrypted(new Uint8Array([OPCODE_SEND.DIE_QUIT]));
    }
    _sendClaimStreak() {
        this._sendEncrypted(new Uint8Array([OPCODE_SEND.CLAIM_STREAK]));
        this.streakData.lastClaimTime = Date.now();
        this.streakData.count += 1;
        this.streakData.nextClaimDeadline = Date.now() + 86400000;
        this._broadcastMapData({
            type: "daily-streak",
            session: this._currentSessionId,
            streakCount: this.streakData.count,
            lastClaimTime: this.streakData.lastClaimTime,
            nextClaimDeadline: this.streakData.nextClaimDeadline,
            canClaim: false,
        });
    }
    _sendMovement(vx, vy, flags = 0) {
        if (this._corruptInvert) {
            vx = -vx;
            vy = -vy;
        }
        const xByte = Math.max(0, Math.min(255, Math.floor((vx * 0.5 + 0.5) * 255)));
        const yByte = Math.max(0, Math.min(255, Math.floor((vy * 0.5 + 0.5) * 255)));
        const actionFlags = flags | (this.serverAttackToggled ? 1 : 0) | (this.serverDefendToggled ? 2 : 0);
        this._sendEncrypted(new Uint8Array([OPCODE_SEND.MOVEMENT, xByte, yByte, actionFlags, 127]));
    }

    _sendTalentApply(talentId) {
        if (this.isSpawned)
            this._sendEncrypted(new Uint8Array([OPCODE_SEND.TALENT_RESET, talentId & 0xff, (talentId >> 8) & 0xff]));
    } // S.oi = 112 spend
    _sendTalentCommit() {
        if (this.isSpawned) this._sendEncrypted(new Uint8Array([OPCODE_SEND.TALENT_APPLY]));
    } // S.ki = 128 apply
    _sendTalents(talentSlugs) {
        if (!Array.isArray(talentSlugs) || talentSlugs.length === 0) return;
        for (const slug of talentSlugs) {
            const id = talentSlugToId[slug];
            if (id !== undefined) this._sendTalentApply(id);
        }
        this._sendTalentCommit();
        this.botEquippedTalents = talentSlugs;
    }
    _sendEquipLoadout(buildObj) {
        if (!this.isSpawned) return;
        const topRow = buildObj.topRow || [];
        const bottomRow = buildObj.bottomRow || null;
        const totalSize = 3 + topRow.length * 2 + (bottomRow ? bottomRow.length * 2 : 0);
        const packet = new Uint8Array(totalSize);
        const view = new DataView(packet.buffer);
        let offset = 0;
        view.setUint8(offset++, OPCODE_SEND.EQUIP_LOADOUT);
        view.setUint8(offset++, bottomRow ? 1 : 0);
        view.setUint8(offset++, topRow.length);
        const encodeRow = (row) => {
            for (const entry of row) {
                let value = 0;
                if (entry) {
                    const [slug, rarity] = entry;
                    const petalId = this._slugToId[slug];
                    if (petalId !== undefined) value = petalId * BUILD_AX + rarity + 1;
                }
                view.setUint16(offset, value);
                offset += 2;
            }
        };
        encodeRow(topRow);
        if (bottomRow) encodeRow(bottomRow);
        this._sendEncrypted(packet);
        this.equipSentTime = Date.now();
        const newPetals = [];
        const addEntry = (entry) => {
            if (!entry) return;
            const [slug, rarityIdx] = entry;
            newPetals.push({
                petalName: this._petalNames[this._slugToId[slug]] || slug,
                rarityName: this._rarities[rarityIdx]?.name || `R${rarityIdx}`,
            });
        };
        for (const entry of topRow) addEntry(entry);
        if (bottomRow) for (const entry of bottomRow) addEntry(entry);
        this.botEquippedPetals = newPetals;
        this._broadcastMapData({
            type: "position",
            session: this._currentSessionId,
            username: this.username,
            x: this.botX,
            y: this.botY,
            petals: this.botEquippedPetals,
            talents: buildObj.talents || [],
            hp: this.botStats?.hpPercent,
            mana: this.botStats?.manaPercent,
            level: this.botStats?.level,
            isPinky: this.isPinky,
            navPath: this.navPath.length > 0 ? this.navPath : undefined,
        });
        if (buildObj.talents && buildObj.talents.length > 0) this._sendTalents(buildObj.talents);
    }

    // ── Broadcast ──
    _broadcastMapData(data) {
        data.accountId = this.accountId;
        data.botTs = Date.now();
        data.lastWsMessageAt = this._lastWsMessageAt;
        data.serverUrl = this.serverUrl;
        if (this._switching) data.switching = true;
        if (data.type === "position" || data.type === "auto-patrol") {
            data.navRouteIndex = this.navRouteIndex;
            data.navRouteCount = this.navRoute.length;
            data.navWaypointIndex = this.navWaypointIndex;
            data.navigateTarget = this.navigateTarget ? { ...this.navigateTarget } : null;
        }
        this._broadcastBuffer[data.type] = data;
        if (!this._broadcastTimer) this._broadcastTimer = setTimeout(() => this._flushBroadcast(), 100);
    }
    _sendDirectMapData(data) {
        data.accountId = this.accountId;
        data.botTs = Date.now();
        data.lastWsMessageAt = this._lastWsMessageAt;
        data.serverUrl = this.serverUrl;
        const postData = JSON.stringify(data);
        try {
            const req = http.request(
                {
                    hostname: "localhost",
                    port: 3000,
                    path: "/mapdata",
                    method: "POST",
                    agent: false,
                    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
                },
                (res) => {
                    res.resume();
                }
            );
            req.on("error", () => {});
            req.end(postData);
        } catch (_) {}
    }
    _flushBroadcast() {
        this._broadcastTimer = null;
        const types = Object.keys(this._broadcastBuffer);
        for (const type of types) {
            const data = this._broadcastBuffer[type];
            delete this._broadcastBuffer[type];
            const postData = JSON.stringify(data);
            const req = http.request({
                hostname: "localhost",
                port: 3000,
                path: "/mapdata",
                method: "POST",
                agent: false,
                headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
            });
            let settled = false;
            req.on("response", (res) => {
                settled = true;
                res.resume();
                if (this._broadcastDown) {
                    this._broadcastDown = false;
                }
            });
            req.on("error", (e) => {
                if (settled) return;
                if (!this._broadcastDown) this._broadcastDown = true;
                this._broadcastBuffer[type] = data;
                if (!this._broadcastTimer) this._broadcastTimer = setTimeout(() => this._flushBroadcast(), 2000);
            });
            req.end(postData);
        }
    }

    // ── Equip ──
    _processPendingEquip() {
        if (!this._pendingEquipCmd) return;
        if (!this.isSpawned) {
            if (this._pendingEquipRetryTimer) return;
            this._pendingEquipRetryTimer = setTimeout(() => {
                this._pendingEquipRetryTimer = null;
                this._processPendingEquip();
            }, 200);
            return;
        }
        const cmd = this._pendingEquipCmd;
        this._pendingEquipCmd = null;
        try {
            if (cmd.buildCode) {
                const build = decodeBuildCode(cmd.buildCode);
                if (build) {
                    if (cmd.talents && cmd.talents.length > 0) build.talents = cmd.talents;
                    this._sendEquipLoadout(build);
                }
            } else {
                const filePath = cmd.buildFile || this._resolveBuildPath("move");
                const b64 = fs.readFileSync(filePath, "utf8").trim();
                const build = decodeBuildCode(b64);
                if (build) {
                    if (cmd.talents && cmd.talents.length > 0) build.talents = cmd.talents;
                    this._sendEquipLoadout(build);
                }
            }
        } catch (e) {
            console.log(`[${this.accountId.slice(0, 8)}] [Bot] Equip error: ${e.message}`);
        }
    }

    _equipBuild(baseName) {
        const filePath = this._resolveBuildPath(baseName);
        this._pendingEquipCmd = { action: "equip", buildFile: filePath, buildCode: null, talents: null };
        this._processPendingEquip();
    }

    // ── Handle control events from map_server ──
    _handleControlEvent(eventName, data) {
        const tag = `[${this.accountId.slice(0, 8)}]`;
        if (eventName === "state") {
            this.serverAttackToggled = !!data.attack;
            this.serverDefendToggled = !!data.defend;
        } else if (eventName === "equip") {
            this._pendingEquipCmd = data;
            this._processPendingEquip();
        } else if (eventName === "navigate") {
            if (data.action === "stop") {
                this._clearNavigation("navigate-stop");
                this._sendMovement(0, 0);
                return;
            }
            this._setNavigateTarget({ x: data.x, y: data.y }, "navigate");
        } else if (eventName === "tracking") {
            this.trackingTargets = data.targets || [];
        } else if (eventName === "ping-rules") {
            this.pingRules = data.rules || [];
        } else if (eventName === "biome-channels") {
            if (data.defaultChannelId !== undefined) this.biomeChannels.defaultChannelId = data.defaultChannelId;
            if (data.biomes) this.biomeChannels.biomes = data.biomes;
        } else if (eventName === "patrol") {
            const route = data.route || [];
            if (route.length > 0) this._setRoute(route, "patrol-event");
        } else if (eventName === "command") {
            if (data.type === "switch") {
                // Manual server switch from the viewer. switchBotServer handles
                // _switching re-entry guard internally.
                this.switchBotServer(data.region, data.biome);
                return;
            }
            if (data.action === "title") {
                if (!this.isDead && !this.respawnState && !this.returnToTitle) {
                    this.isDead = true;
                    this.isSpawned = false;
                    this._clearNavigation("title");
                    this.returnToTitle = true;
                    this.respawnState = "die_sent";
                    this._sendDie();
                }
            } else if (data.action === "spawn") {
                this.returnToTitle = false;
                if (!this.isSpawned && this.respawnState !== "spawn_sent") {
                    this._sendSpawn(this.botName);
                    this.respawnState = "spawn_sent";
                }
            } else if (data.action === "death") {
                if (!this.isDead && !this.respawnState) {
                    this.isDead = true;
                    this.isSpawned = false;
                    this._clearNavigation("death-command");
                    this.respawnState = "die_sent";
                    this._sendDie();
                }
            }
        } else if (eventName === "auto-patrol") {
            console.log(
                `[${this.accountId.slice(0, 8)}] [AP] SSE received: action=${data.action} servers=${data.servers?.length} switching=${this._switching} active=${this._AP.active} state=${this._AP.state}`
            );
            if (data.action === "start") this.apStart(data.servers);
            else if (data.action === "stop") this.apStop();
        } else if (eventName === "daily-claim") {
            this._sendClaimStreak();
        }
    }

    // ── SSE Control Stream ──
    _connectControlStream(serverUrl) {
        if (this._controlStreamReq) {
            try {
                this._controlStreamReq.destroy();
            } catch (e) {}
        }
        if (this._controlStreamReconnectTimer) {
            clearTimeout(this._controlStreamReconnectTimer);
            this._controlStreamReconnectTimer = null;
        }
        const baseUrl = serverUrl || MAP_SERVER_URL;
        const url = new URL("/control-stream", baseUrl);
        url.searchParams.set("accountId", this.accountId);
        /** @type {BotSession} */
        const bot = this;
        const req = http.request(
            {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname + url.search,
                method: "GET",
                agent: false,
                headers: { Accept: "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" },
            },
            /** @param {import("http").IncomingMessage} res */
            (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    bot._onStreamClosed();
                    return;
                }
                bot._controlStreamConnected = true;
                bot._controlStreamBackoffMs = _CONTROL_BACKOFF_INITIAL_MS;
                let buffer = "",
                    currentEvent = "message",
                    cleanupDone = false;
                const onClosed = (wasConnected) => {
                    if (cleanupDone) return;
                    cleanupDone = true;
                    this._controlStreamConnected = false;
                    if (bot._controlStreamReq === req) bot._controlStreamReq = null;
                    bot._scheduleControlReconnect();
                };
                res.setEncoding("utf8");
                res.on("data", (chunk) => {
                    buffer += chunk;
                    let idx;
                    while ((idx = buffer.indexOf("\n\n")) !== -1) {
                        const raw = buffer.slice(0, idx);
                        buffer = buffer.slice(idx + 2);
                        currentEvent = "message";
                        let dataLines = [];
                        for (const line of raw.split("\n")) {
                            if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
                            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
                        }
                        if (dataLines.length === 0) continue;
                        try {
                            bot._handleControlEvent(currentEvent, JSON.parse(dataLines.join("\n")));
                        } catch (e) {}
                    }
                });
                res.on("end", () => onClosed(true));
                res.on("close", () => onClosed(true));
                res.on("error", () => onClosed(true));
            }
        );
        req.on("error", () => {
            this._controlStreamConnected = false;
            this._scheduleControlReconnect();
        });
        req.end();
        this._controlStreamReq = req;
    }

    _onStreamClosed() {
        this._controlStreamConnected = false;
        this._scheduleControlReconnect();
    }
    _scheduleControlReconnect() {
        if (this._controlStreamConnected) return;
        if (this._controlStreamReconnectTimer) return;
        const delay = this._controlStreamBackoffMs;
        this._controlStreamBackoffMs = Math.min(this._controlStreamBackoffMs * 2, _CONTROL_BACKOFF_MAX_MS);
        this._controlStreamReconnectTimer = setTimeout(() => {
            this._controlStreamReconnectTimer = null;
            this._connectControlStream();
        }, delay);
    }
    _initControlDiscoveryListener() {
        // Connect directly to the map server control stream. The previous UDP
        // discovery could only bind one socket per process, which broke when
        // multiple accounts ran in the same account_manager process.
        if (!this._controlStreamConnected && !this._controlStreamReconnectTimer) {
            this._connectControlStream();
        }
    }

    // ── Handle server messages ──
    _handleMessage(bytes) {
        if (bytes.length === 0) return;
        this._lastWsMessageAt = Date.now();
        const opcode = bytes[0];
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (!this.receivedOpcodes.has(opcode)) {
            this.receivedOpcodes.add(opcode);
            const ascii = getPrintableAscii(bytes.slice(1));
            console.log(
                `[${this.accountId.slice(0, 8)}] [Recv] Opcode 0x${opcode.toString(16).padStart(2, "0")} (${opcode}) Size:${bytes.length}${ascii ? ` [${ascii}]` : ""}`
            );
        }
        if (this.equipSentTime && Date.now() - this.equipSentTime < 3000 && opcode === 109) this.equipSentTime = null;

        // Opcode 0: Kick
        if (opcode === 0) {
            const reasons = [
                "invalidProtocol",
                "outdatedVersion",
                "tooManyConnections",
                "afk",
                "loginFailed",
                "banned",
                "adminAction",
                "restricted",
            ];
            const tag = `[${this.accountId.slice(0, 8)}]`;
            console.log(`${tag} ★ KICKED: ${reasons[bytes[1]] || bytes[1]}`);
            try {
                this.ws.close();
            } catch (e) {}
        }

        // Opcode 1: Login Success
        if (opcode === 1) {
            this.loggedIn = true;
            if (bytes.length >= 5) this.botId = view.getUint32(1);
            try {
                let v = 1;
                v += 4; // rmId
                v += 1; // tFlags
                v += 2; // ez
                this.serverMapSize = view.getUint32(v);
                v += 4;
                v += 2; // kM
                v += 8; // skip high score
                const score = view.getUint32(v);
                v += 4;
                const usernameLen = view.getUint8(v);
                this.username = Buffer.from(bytes.buffer, bytes.byteOffset + v + 1, usernameLen).toString("utf8");
                v += 1 + usernameLen;
                // Updated login packet (post game-update): the old desc/lobbyFlag
                // fields were replaced by a second length-prefixed name plus a
                // trailing float, all before mapName.
                v += 1; // unk1 (was lobbyFlag slot)
                const displayNameLen = view.getUint8(v);
                this.displayName = Buffer.from(bytes.buffer, bytes.byteOffset + v + 1, displayNameLen).toString("utf8");
                v += 1 + displayNameLen;
                v += 1; // unk2
                v += 4; // unkFloat
                const mapNameLen = view.getUint8(v++);
                this.mapName = Buffer.from(bytes.buffer, bytes.byteOffset + v, mapNameLen).toString("utf8");
                v += mapNameLen;
                const biomeNameLen = view.getUint8(v++);
                this.biomeName = Buffer.from(bytes.buffer, bytes.byteOffset + v, biomeNameLen).toString("utf8");
                v += biomeNameLen;
                v += 3; // padding before gridWidth (gridWidth is now a single byte)
                this.gridWidth = view.getUint8(v);
                v += 1;
                const gridArea = this.gridWidth * this.gridWidth;
                const gridBytes = Math.ceil(gridArea / 8);
                this.mapGrid = [];
                for (let row = 0; row < this.gridWidth; row++) {
                    this.mapGrid[row] = [];
                    for (let col = 0; col < this.gridWidth; col++) {
                        const bitIdx = row * this.gridWidth + col;
                        this.mapGrid[row][col] = (bytes[v + Math.floor(bitIdx / 8)] >> (bitIdx % 8)) & 1;
                    }
                }
                v += gridBytes;
                this._distanceMap = buildDistanceMap(this.mapGrid, this.gridWidth, this.gridWidth);

                // The post-grid section (equipped petals / inventory / skins /
                // talents / daily-streak) changed format in the same game update
                // that altered the login packet: it now carries entity data, so the
                // original field offsets no longer apply. Leave these structures
                // empty until re-decoded to avoid ingesting entity bytes as garbage
                // petals/inventory.
                this.botEquippedPetals = [];
                this.botInventory = {};

                // Broadcast map
                const _urlMatch = this.serverUrl.match(/s-([a-z]+)-([a-z]+)\./);
                const _region = _urlMatch ? _urlMatch[1] : "";
                const _urlBiome = _urlMatch ? _urlMatch[2] : "";
                this._broadcastMapData({
                    type: "map",
                    session: this._currentSessionId,
                    username: this.username,
                    mapName: this.mapName,
                    biomeName: this.biomeName,
                    region: _region,
                    serverBiome: _urlBiome,
                    gridWidth: this.gridWidth,
                    grid: this.mapGrid,
                    mapSize: this.serverMapSize,
                });
                this._recomputePathIfNavigating();
                this._broadcastMapData({
                    type: "daily-streak",
                    session: this._currentSessionId,
                    streakCount: this.streakData.count,
                    lastClaimTime: this.streakData.lastClaimTime,
                    nextClaimDeadline: this.streakData.nextClaimDeadline,
                    canClaim: this.streakData.lastClaimTime === 0 || Date.now() > this.streakData.nextClaimDeadline,
                });
                this.apOnLogin();
            } catch (err) {
                console.error(`[${this.accountId.slice(0, 8)}] Login parse error: ${err.message}`);
            }

            if (!this.pingInterval) this.pingInterval = setInterval(() => this._sendPing(), 1000);
            // Turn off "Show Other Pets" on login.
            this._sendShowOtherPets(false);

            if (!this.spawnSent) {
                setTimeout(() => {
                    this._sendSpawn(this.botName);
                    this.spawnSent = true;
                    // Fallback: force _onSpawned if opcode 3 didn't trigger within 3s
                    if (!this.isSpawned) {
                        setTimeout(() => {
                            if (!this.isSpawned) {
                                this.isSpawned = true;
                                this._onSpawned();
                            }
                        }, 3000);
                    }
                }, 500);
            }
        }

        // Opcode 3: Entity Updates
        if (opcode === 3) {
            this._parseEntityUpdates(bytes);
            if (this.respawnState === "spawn_sent" && !this.isSpawned) {
                this.isSpawned = true;
                this.isDead = false;
                this.respawnState = "";
                this.apOnSpawned();
            }
            if (this.spawnSent && !this.isSpawned && !this.respawnState && !this.returnToTitle) {
                this.isSpawned = true;
                this._onSpawned();
            }
        }

        // Opcode 11: Inventory/Stats
        if (opcode === 11) {
            try {
                let iv = 1;
                const invCount = view.getUint16(iv);
                iv += 2;
                if (invCount > 0 && 3 + invCount * 6 <= bytes.length) {
                    this.botInventory = {};
                    for (let t = 0; t < invCount && iv + 6 <= bytes.length; t++) {
                        const pk = view.getUint16(iv);
                        iv += 2;
                        const cnt = view.getUint32(iv);
                        iv += 4;
                        this.botInventory[pk] = cnt;
                    }
                }
            } catch (e) {}
        }

        // Opcode 4: Death
        if (opcode === 4) {
            if (!this.isDead) {
                this.isDead = true;
                this.isSpawned = false;
                this._clearNavigation("death-opcode");
            }
            this.apOnDeath();
            this._sendDie();
            this.respawnState = "die_sent";
        }

        // Opcode 5: Cleanup/Ready to respawn
        if (opcode === 5 && this.respawnState === "die_sent") {
            if (this.returnToTitle) {
                this.respawnState = "";
                this.isDead = false;
                this._broadcastMapData({ type: "despawn", session: this._currentSessionId });
            } else {
                this._sendSpawn(this.botName);
                this.respawnState = "spawn_sent";
            }
        }

        // Opcode 6: Revive
        if (opcode === 6) {
            this.isDead = false;
            this.isSpawned = true;
            this.returnToTitle = false;
            this.respawnState = "";
        }

        // Log unhandled opcodes to help debug server-side messages (e.g. 0x08)
        if (![0, 1, 3, 4, 5, 6, 11, 50, 111].includes(opcode)) {
            const payloadHex = Array.from(bytes)
                .slice(1)
                .map((b) => b.toString(16).padStart(2, "0"))
                .join(" ");
            const payloadAscii = getPrintableAscii(bytes.slice(1));
            console.log(
                `[${this.accountId.slice(0, 8)}] [Un-handled Opcode] ${opcode} size=${bytes.length} hex=[${payloadHex}] ascii=[${payloadAscii}]`
            );
        }
    }

    // ── Entity parsing ──
    _parseEntityUpdates(bytes) {
        if (bytes.length < 19) return;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        try {
            let v = 1;
            v += 2;
            v += 4;
            v += 2;
            v += 4;
            v += 2;
            v += 2; // header
            const entityCount = view.getUint16(v);
            v += 2;
            for (let i = 0; i < entityCount && v + 4 <= bytes.length; i++) {
                const entityId = view.getUint32(v);
                v += 4;
                try {
                    if (this.knownEntities.has(entityId)) v = this._parseEntityUpdate(view, bytes, v, entityId);
                    else v = this._parseEntitySpawn(view, bytes, v, entityId);
                } catch (e) {
                    v += 4;
                }
                if (v < 0 || v > bytes.length) break;
            }
            // Deletions
            if (v + 2 <= bytes.length) {
                const dc = view.getUint16(v);
                v += 2;
                for (let i = 0; i < dc && v + 4 <= bytes.length; i++) {
                    const did = view.getUint32(v);
                    v += 4;
                    this.knownEntities.delete(did);
                    this.activePetals.delete(did);
                    this.activeMobs.delete(did);
                }
            }
            if (v + 2 <= bytes.length) {
                const dc = view.getUint16(v);
                v += 2;
                for (let i = 0; i < dc && v + 4 <= bytes.length; i++) {
                    const did = view.getUint32(v);
                    v += 4;
                    this.knownEntities.delete(did);
                    this.activePetals.delete(did);
                    this.activeMobs.delete(did);
                }
            }
        } catch (e) {}

        // Broadcast position + mobs
        if (this.isSpawned && !this.isDead && (this.botX !== 0 || this.botY !== 0)) {
            const mobList = [];
            for (const [id, mob] of this.activeMobs) {
                if (mob.x === undefined || mob.y === undefined) continue;
                // Pets spawned from eggs (game Ts flag, yellow render) are not real
                // mobs — exclude from Mob List and tracking notifications.
                if (mob.isPet) continue;
                const dist = Math.sqrt((mob.x - this.botX) ** 2 + (mob.y - this.botY) ** 2);
                mobList.push({
                    id,
                    x: mob.x,
                    y: mob.y,
                    name: mob.mobName || "Unknown",
                    slug: mob.mobSlug || mob.mobName.toLowerCase().replace(/ /g, "_"),
                    rarity: mob.rarityIndex ?? 0,
                    variant: mob.variant ?? 0,
                    size: mob.size || 0,
                    dist: Math.round(dist),
                });
            }
            mobList.sort((a, b) => a.dist - b.dist);

            // Tracking
            if (this.trackingTargets.length > 0 && this.botToken && this._AP.active && !this._switching) {
                for (const mob of mobList) {
                    for (const target of this.trackingTargets) {
                        if (mob.slug !== target.slug || target.enabled === false) continue;
                        if (target.variants?.length > 0 && !target.variants.includes(mob.variant)) continue;
                        if (target.rarities?.length > 0 && !target.rarities.includes(mob.rarity)) continue;
                        const cellSz = this.serverMapSize / this.gridWidth;
                        const gridX = Math.floor(mob.x / cellSz),
                            gridY = Math.floor(mob.y / cellSz);
                        if (
                            this.notifiedMobs.some(
                                (e) =>
                                    e.name === mob.name &&
                                    e.variant === mob.variant &&
                                    e.rarity === mob.rarity &&
                                    Math.abs(e.gridX - gridX) <= 2 &&
                                    Math.abs(e.gridY - gridY) <= 2
                            )
                        )
                            continue;
                        this.notifiedMobs.push({
                            name: mob.name,
                            variant: mob.variant,
                            rarity: mob.rarity,
                            gridX,
                            gridY,
                        });
                        this._sendDiscordAlert(mob);
                    }
                }
            }

            this._broadcastMapData({
                type: "position",
                session: this._currentSessionId,
                username: this.username,
                x: this.botX,
                y: this.botY,
                petals: this.botEquippedPetals,
                talents: this.botEquippedTalents,
                hp: this.botStats?.hpPercent,
                mana: this.botStats?.manaPercent,
                level: this.botStats?.level,
                isPinky: this.isPinky,
                navPath: this.navPath.length > 0 ? this.navPath : undefined,
            });
            this._broadcastMapData({ type: "mobs", session: this._currentSessionId, mobs: mobList });
            if (this.mapGrid && this.mapGrid.length > 0 && Date.now() - this._lastMapBroadcast > 5000) {
                this._lastMapBroadcast = Date.now();
                const um = this.serverUrl.match(/s-([a-z]+)-([a-z]+)\./);
                this._broadcastMapData({
                    type: "map",
                    session: this._currentSessionId,
                    username: this.username,
                    mapName: this.mapName,
                    biomeName: this.biomeName,
                    region: um ? um[1] : "",
                    serverBiome: um ? um[2] : "",
                    gridWidth: this.gridWidth,
                    grid: this.mapGrid,
                    mapSize: this.serverMapSize,
                });
            }
        }
    }

    _parseEntityUpdate(view, bytes, v, entityId) {
        if (v + 2 > bytes.length) return v;
        const flags = view.getUint16(v);
        v += 2;
        const entity = this.knownEntities.get(entityId);
        // Flag order and read sizes mirror the game's S.update handler exactly.
        if (flags & UPDATE_FLAGS.POSITION) {
            if (v + 4 > bytes.length) return v;
            const x = decompressCoord(view.getUint16(v));
            v += 2;
            const y = decompressCoord(view.getUint16(v));
            v += 2;
            if (entityId === this.botId) {
                if (this.botX !== 0 && this.botY !== 0) {
                    if (Math.abs(x - this.botX) > 5000 || Math.abs(y - this.botY) > 5000) {
                        this.botOutlierCount++;
                        if (this.botOutlierCount >= 5) {
                            this.botX = x;
                            this.botY = y;
                            this.botOutlierCount = 0;
                            this._recomputePathIfNavigating();
                        }
                    } else {
                        this.botX = x;
                        this.botY = y;
                        this.botOutlierCount = 0;
                        this._recomputePathIfNavigating();
                    }
                } else {
                    this.botX = x;
                    this.botY = y;
                    this._recomputePathIfNavigating();
                }
                if (this.botStats) {
                    this.botStats.x = x;
                    this.botStats.y = y;
                }
            } else if (this.activePetals.has(entityId)) {
                const p = this.activePetals.get(entityId);
                p.x = x;
                p.y = y;
            } else if (this.activeMobs.has(entityId)) {
                const m = this.activeMobs.get(entityId);
                m.x = x;
                m.y = y;
            }
        }
        if (flags & UPDATE_FLAGS.ANGLE) {
            if (v + 1 > bytes.length) return v;
            v += 1;
        }
        if (flags & UPDATE_FLAGS.SIZE) {
            if (v + 2 > bytes.length) return v;
            v += 2;
        }
        // LAYER: 0B payload (client-side toggle) — nothing to skip
        if (flags & UPDATE_FLAGS.SE) {
            if (v + 1 > bytes.length) return v;
            v += 1;
        }
        if (flags & UPDATE_FLAGS.STATUS) {
            if (v + 4 > bytes.length) return v;
            const sf = view.getUint32(v); // sv() bitmask
            v += 4;
            if (entityId === this.botId && this.botStats) {
                this.botStats.statusFlags = sf;
                const wasPinky = this.isPinky;
                this.isPinky = !!(sf & this._PINKY_BITMASK);
                if (this.isPinky !== wasPinky) this._onPinkyStateChanged(this.isPinky);
            }
        }
        if (flags & UPDATE_FLAGS.LEVEL) {
            if (v + 2 > bytes.length) return v;
            const lv = view.getUint16(v);
            v += 2;
            if (entityId === this.botId && this.botStats) this.botStats.level = lv;
        }
        if (flags & UPDATE_FLAGS.FACE) {
            if (v + 3 > bytes.length) return v;
            v += 3;
        } // y(): face + mobSkin + aura
        if (flags & UPDATE_FLAGS.CE) {
            if (v + 1 > bytes.length) return v;
            v += 1;
        }
        if (flags & UPDATE_FLAGS.GUILD) {
            const r = readString(view, v);
            v = r.newOffset;
        }
        if (flags & UPDATE_FLAGS.MANA) {
            if (v + 1 > bytes.length) return v;
            const mn = view.getUint8(v++) / 255;
            if (entityId === this.botId && this.botStats) this.botStats.manaPercent = (mn * 100).toFixed(1);
        }
        if (flags & UPDATE_FLAGS.HE) {
            if (v + 1 > bytes.length) return v;
            v += 1;
        }
        if (flags & UPDATE_FLAGS.GE) {
            if (v + 4 > bytes.length) return v;
            v += 4;
        }
        // snake body segments (game: s.Hr loop, 4B per segment)
        if (entity && entity.snakeCount > 0) {
            for (let s = 0; s < entity.snakeCount; s++) {
                if (v + 4 > bytes.length) return v;
                v += 4;
            }
        }
        if (flags & UPDATE_FLAGS.HEALTH) {
            if (v + 2 > bytes.length) return v;
            const hp = view.getUint8(v++) / 255;
            const mn = view.getUint8(v++) / 255;
            if (entityId === this.botId && this.botStats) {
                this.botStats.hpPercent = (hp * 100).toFixed(1);
                this.botStats.manaPercent = (mn * 100).toFixed(1);
            }
        }
        if (flags & UPDATE_FLAGS.PE) {
            if (v + 1 > bytes.length) return v;
            const pm = view.getUint8(v++);
            for (let b = 0; b < 8; b++) {
                if (pm & (1 << b)) {
                    if (v + 4 > bytes.length) return v;
                    v += 4;
                }
            }
        }
        return v;
    }

    _parseEntitySpawn(view, bytes, v, entityId) {
        if (v + 1 > bytes.length) return v;
        const entityType = view.getUint8(v++);
        if (entityType === ENTITY_TYPE.LIGHTNING) {
            if (v + 1 > bytes.length) return v;
            const pc = view.getUint8(v++);
            v += pc * 4;
            this.knownEntities.set(entityId, { type: entityType, snakeCount: 0 });
            return v;
        }
        if (entityType === ENTITY_TYPE.EXPLOSION) {
            v += 7;
            this.knownEntities.set(entityId, { type: entityType, snakeCount: 0 });
            return v;
        }
        if (v + 8 > bytes.length) return v;
        const layer = view.getUint8(v++);
        const x = decompressCoord(view.getUint16(v));
        v += 2;
        const y = decompressCoord(view.getUint16(v));
        v += 2;
        const size = view.getUint16(v);
        v += 2;
        const angle = view.getUint8(v++);
        let snakeCount = 0;

        switch (entityType) {
            case ENTITY_TYPE.PLAYER: {
                const un = readString(view, v);
                v = un.newOffset;
                const nn = readString(view, v);
                v = nn.newOffset;
                const gu = readString(view, v);
                v = gu.newOffset;
                if (v + 4 > bytes.length) return v;
                const sf = view.getUint32(v);
                v += 4;
                if (v + 2 > bytes.length) return v;
                const lv = view.getUint16(v);
                v += 2;
                if (v + 3 > bytes.length) return v;
                v += 3; // y(a): face + mobSkin + aura (3 bytes)
                if (v + 3 > bytes.length) return v;
                v += 3; // a.Ip + a.sp + a.Un (3 bytes)
                if (v + 2 > bytes.length) return v;
                const hp = view.getUint8(v++) / 255;
                const mn = view.getUint8(v++) / 255; // i(a)
                if (entityId === this.botId) {
                    this.botStats = {
                        entityId,
                        rarity: layer,
                        x,
                        y,
                        size,
                        angle,
                        username: un.value,
                        nickname: nn.value,
                        guild: gu.value,
                        statusFlags: sf,
                        level: lv,
                        hpPercent: (hp * 100).toFixed(1),
                        manaPercent: (mn * 100).toFixed(1),
                    };
                    this.botX = x;
                    this.botY = y;
                    this._recomputePathIfNavigating();
                    const wasPinky = this.isPinky;
                    this.isPinky = !!(sf & this._PINKY_BITMASK);
                    if (this.isPinky !== wasPinky) this._onPinkyStateChanged(this.isPinky);
                }
                break;
            }
            case ENTITY_TYPE.PETAL: {
                if (v + 2 > bytes.length) return v;
                const pv = view.getUint16(v);
                v += 2;
                // game E.H: u16 item + f32 weight/offset (4B) — must skip both
                if (v + 4 > bytes.length) return v;
                v += 4;
                const [pi, ri] = decodeItemValue(pv);
                this.activePetals.set(entityId, {
                    entityId,
                    x,
                    y,
                    size,
                    petalName: this._petalNames[pi] || `Petal_${pi}`,
                    rarityName: this._rarities[ri]?.name || `R${ri}`,
                    petalIndex: pi,
                    rarityIndex: ri,
                    lastUpdated: Date.now(),
                });
                break;
            }
            case ENTITY_TYPE.MOB: {
                if (v + 2 > bytes.length) return v;
                const mv = view.getUint16(v);
                v += 2;
                const [mi, mri] = decodeItemValue(mv);
                if (v + 2 > bytes.length) return v;
                const mobVar = view.getUint8(v++);
                const mobFl = view.getUint8(v++);
                // Defensive: skip mobs with invalid indices to avoid polluting the
                // map with mis-parsed/out-of-sync entities (e.g. Mob_1789).
                if (mi < 0 || mi >= (this._mobNames?.length || 0)) {
                    const tag = `[${this.accountId.slice(0, 8)}]`;
                    console.log(`${tag} [Mob] Skipping invalid mob index ${mi} (raw=${mv}) entityId=${entityId}`);
                    v += 2; // skip HP/mana bytes (i(a)) to maintain alignment
                    break;
                }
                const mName = this._mobNames[mi] || `Mob_${mi}`;
                if (this._snakeMobIndices.has(mi)) {
                    if (v + 1 > bytes.length) return v;
                    const sc = view.getUint8(v++);
                    snakeCount = sc;
                    v += sc * 4;
                }
                v += 2; // HP/mana bytes (matching reference i(a))
                this.activeMobs.set(entityId, {
                    entityId,
                    x,
                    y,
                    size,
                    mobName: mName,
                    mobSlug: this._mobSlugs[mi] || mName.toLowerCase().replace(/ /g, "_"),
                    mobIndex: mi,
                    rarityIndex: mri,
                    variant: mobVar,
                    // game r&2 (Ts) = yellow-rendered entity = pet spawned from an egg/pet
                    isPet: !!(mobFl & 2),
                    lastUpdated: Date.now(),
                });
                break;
            }
            case ENTITY_TYPE.DROP: {
                if (v + 6 > bytes.length) return v;
                v += 6;
                break;
            }
            case ENTITY_TYPE.ZONE_O: {
                if (v + 1 > bytes.length) return v;
                v += 1;
                break;
            }
            case ENTITY_TYPE.ZONE_B:
            case ENTITY_TYPE.ZONE_U:
            case ENTITY_TYPE.WALL: {
                break;
            }
            case ENTITY_TYPE.UNDERSCORE: {
                const us = readString(view, v);
                v = us.newOffset;
                break;
            }
            case ENTITY_TYPE.ZONE_G: {
                if (v + 3 > bytes.length) return v;
                v += 3;
                break;
            }
            case ENTITY_TYPE.ZONE_Q: {
                if (v + 1 > bytes.length) return v;
                v += 1;
                break;
            }
            case ENTITY_TYPE.ZONE_V: {
                if (v + 9 > bytes.length) return v;
                v += 9;
                break;
            }
            default:
                break;
        }
        this.knownEntities.set(entityId, { type: entityType, snakeCount });
        return v;
    }

    // ── Pinky state ──
    _onPinkyStateChanged(nowPinky) {
        this.apOnPinkyState(nowPinky);
        this._broadcastMapData({
            type: "position",
            session: this._currentSessionId,
            x: this.botX,
            y: this.botY,
            petals: this.botEquippedPetals,
            talents: this.botEquippedTalents,
            hp: this.botStats?.hpPercent,
            mana: this.botStats?.manaPercent,
            level: this.botStats?.level,
            isPinky: this.isPinky,
            navPath: this.navPath.length > 0 ? this.navPath : undefined,
        });
    }

    _onSpawned() {
        const tag = `[${this.accountId.slice(0, 8)}]`;
        console.log(`${tag} [Bot] SPAWNED! Starting movement AI...`);
        this._resetStuck();
        this.apOnSpawned();
        this._processPendingEquip();
        if (!this.pollInterval) this.pollInterval = setInterval(() => this._pollCommand(), 2000);
        if (this.movementInterval) clearInterval(this.movementInterval);
        this.movementInterval = setInterval(() => {
            if (!this.isSpawned) return;
            this._navigateTick();
        }, 33);
    }

    _pollCommand() {
        const baseUrl = MAP_SERVER_URL;
        const params = `?accountId=${encodeURIComponent(this.accountId)}`;
        Promise.all([
            fetch(new URL(`/command${params}`, baseUrl)).catch(() => null),
            fetch(new URL(`/state${params}`, baseUrl)).catch(() => null),
        ])
            .then(([cmdRes, stateRes]) => {
                if (stateRes)
                    return stateRes.json().then((s) => {
                        this.serverAttackToggled = !!s.attack;
                        this.serverDefendToggled = !!s.defend;
                        return cmdRes ? cmdRes.json() : null;
                    });
                return cmdRes ? cmdRes.json() : null;
            })
            .then((cmd) => {
                if (!cmd) return;
                if (cmd.action === "navigate") {
                    this._setNavigateTarget({ x: cmd.x, y: cmd.y }, "poll-navigate");
                } else if (cmd.action === "death") {
                    if (!this.isDead && !this.respawnState) {
                        this.isDead = true;
                        this.isSpawned = false;
                        this._clearNavigation("poll-death");
                        this.respawnState = "die_sent";
                        this._sendDie();
                    }
                } else if (cmd.action === "title") {
                    if (!this.isDead && !this.respawnState && !this.returnToTitle) {
                        this.isDead = true;
                        this.isSpawned = false;
                        this._clearNavigation("poll-title");
                        this.returnToTitle = true;
                        this.respawnState = "die_sent";
                        this._sendDie();
                    }
                } else if (cmd.action === "spawn") {
                    this.returnToTitle = false;
                    if (!this.isSpawned && this.respawnState !== "spawn_sent") {
                        this._sendSpawn(this.botName);
                        this.respawnState = "spawn_sent";
                    }
                } else if (cmd.action === "equip") {
                    if (!this._pendingEquipCmd) this._pendingEquipCmd = cmd;
                } else if (cmd.type === "switch") {
                    this.switchBotServer(cmd.region, cmd.biome);
                } else if (cmd.action === "patrol") {
                    const r = cmd.route || [];
                    if (r.length > 0) this._setRoute(r, "poll-patrol");
                }
            })
            .catch(() => {});
    }

    /**
     * Mixin method declarations (typed loosely for checkJs; replaced at
     * runtime by Object.assign below).
     * Mixed in from lib/bot modules; stubs are replaced at runtime by Object.assign.
     */
    /** @param {...any} _ */
    _resetStuck(..._) {}
    /** @param {...any} _ */
    _clearNavigation(..._) {}
    /** @param {...any} _ */
    _setNavigateTarget(..._) {}
    /** @param {...any} _ */
    _setRoute(..._) {}
    /** @param {...any} _ */
    _advanceRouteWaypoint(..._) {}
    /** @param {...any} _ */
    _computePath(..._) {}
    /** @param {...any} _ */
    _recomputePathIfNavigating(..._) {}
    /** @param {...any} _ */
    _isCellBlockedByMob(..._) {}
    /** @param {...any} _ */
    _wallAwareMove(..._) {}
    /** @param {...any} _ */
    _findNearestWallDir(..._) {}
    /** @param {...any} _ */
    _navigateTick(..._) {}
    /** @param {...any} _ */
    apLog(..._) {}
    /** @param {...any} _ */
    apClearTimers(..._) {}
    /** @param {...any} _ */
    apStop(..._) {}
    /** @param {...any} _ */
    apStart(..._) {}
    /** @param {...any} _ */
    apAdvance(..._) {}
    /** @param {...any} _ */
    apOnLogin(..._) {}
    /** @param {...any} _ */
    apOnSpawned(..._) {}
    /** @param {...any} _ */
    apOnPinkyState(..._) {}
    /** @param {...any} _ */
    apOnDeath(..._) {}
    /** @param {...any} _ */
    apOnRouteComplete(..._) {}
    /** @param {...any} _ */
    _generateMobMapImage(..._) {}
    /** @param {...any} _ */
    _sendDiscordAlert(..._) {}
}

// Runtime mix-in replaces the stub declarations above. Class prototypes hold
// non-enumerable methods, so copy descriptors explicitly (Object.assign would skip them).
for (const mixin of [BotNavigable, BotAutopatrol, BotRenderable]) {
    for (const name of Object.getOwnPropertyNames(mixin)) {
        if (name === "constructor") continue;
        const desc = Object.getOwnPropertyDescriptor(mixin, name);
        if (desc) Object.defineProperty(BotSession.prototype, name, desc);
    }
}

// Mix in extracted method groups (navigation, auto-patrol, rendering/discord).
// Re-exports for back-compat (tests import these from bot_session.js).
export { BotSession };
export {
    buildDistanceMap,
    decodeBuildCode,
    decodeItemValue,
    LCG,
    MinHeap,
    decompressCoord,
    readString,
    decodeStatusFlags,
    getPrintableAscii,
};
