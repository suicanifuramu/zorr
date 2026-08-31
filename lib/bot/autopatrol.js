// autopatrol.js — Auto Patrol state machine: server rotation, pinky hunting,
// build switching, cooldowns, and the AP event log.
// ponytail: mixins are copied onto BotSession.prototype; full typing blocked on 285 this-props errors, revisit when Phase 7 completes
// @ts-nocheck
import http from "node:http";
import { AP_LOG_MAX } from "./protocol.js";

class _BotAutopatrol {
    constructor() {
        /** @type {any} */ this.botX;
    }
    // ── Auto Patrol ──
    apLog(msg) {
        const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
        this._AP.log.push(line);
        if (this._AP.log.length > AP_LOG_MAX) this._AP.log.shift();
        this._broadcastMapData({
            type: "auto-patrol",
            session: this._currentSessionId,
            state: this._AP.state,
            pinkyFailCount: this._AP.pinkyFailCount,
            active: this._AP.active,
            currentServer: this._AP.servers[this._AP.serverIndex] || null,
            serverIndex: this._AP.serverIndex,
            serverCount: this._AP.servers.length,
            log: this._AP.log.slice(-10),
        });
    }
    apClearTimers() {
        if (this._AP.pinkyTimeout) {
            clearTimeout(this._AP.pinkyTimeout);
            this._AP.pinkyTimeout = null;
        }
        if (this._AP.buildSwitchTimeout) {
            clearTimeout(this._AP.buildSwitchTimeout);
            this._AP.buildSwitchTimeout = null;
        }
        if (this._AP.cooldownTimer) {
            clearTimeout(this._AP.cooldownTimer);
            this._AP.cooldownTimer = null;
        }
        if (this._AP.patrolTimeout) {
            clearTimeout(this._AP.patrolTimeout);
            this._AP.patrolTimeout = null;
        }
    }
    apStop() {
        this.apClearTimers();
        this._AP.active = false;
        this._AP.state = "idle";
        this._AP.pinkyFailCount = 0;
        this._AP.servers = [];
        this._AP.serverIndex = 0;
        this._AP.log = [];
        this._clearNavigation("ap-stop");
        this._sendMovement(0, 0);
        this.apLog("Auto Patrol STOPPED");
    }
    apStart(servers) {
        const tag = `[${this.accountId.slice(0, 8)}]`;
        console.log(
            `${tag} [AP] apStart called: active=${this._AP.active} state=${this._AP.state} servers=${servers?.length}`
        );
        if (this._AP.active) this.apStop();
        this._AP.active = true;
        this._AP.servers =
            this._assignedServers && this._assignedServers.length > 0 ? this._assignedServers : servers || [];
        this._AP.pinkyFailCount = 0;
        this._AP.state = "next_server";
        const um = this.serverUrl.match(/s-([a-z]+)-([a-z]+)\./);
        if (um) {
            const idx = this._AP.servers.findIndex((s) => s.region === um[1] && s.biome === um[2]);
            this._AP.serverIndex = idx >= 0 ? idx : 0;
        } else this._AP.serverIndex = 0;
        this.apLog(`Auto Patrol STARTED: ${this._AP.servers.length} servers, starting at ${this._AP.serverIndex}`);
        this._sendDirectMapData({
            type: "auto-patrol",
            session: this._currentSessionId,
            state: this._AP.state,
            pinkyFailCount: this._AP.pinkyFailCount,
            active: this._AP.active,
            currentServer: this._AP.servers[this._AP.serverIndex] || null,
            serverIndex: this._AP.serverIndex,
            serverCount: this._AP.servers.length,
            log: this._AP.log.slice(-10),
        });
        this._fetchRoutes()
            .then(() => {
                console.log(`${tag} [AP] routes fetched, calling apAdvance`);
                this.apAdvance();
            })
            .catch(() => {
                this.apLog("Route fetch failed");
                this.apAdvance();
            });
    }
    _fetchRoutes() {
        /** @type {Promise<void>} */
        const p = new Promise((resolve, reject) => {
            http.get("http://localhost:3000/routes", (res) => {
                let body = "";
                res.on("data", (c) => (body += c));
                res.on("end", () => {
                    try {
                        this._AP.routes = JSON.parse(body) || {};
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
            }).on("error", reject);
        });
        return p;
    }
    /**
     * Advance to the next patrol server.
     * @param {boolean} [immediate=false]  skip the switch dwell (death / route complete)
     */
    apAdvance(immediate = false) {
        if (!this._AP.active) return;
        if (this._AP.serverIndex >= this._AP.servers.length) {
            this.apLog("All servers completed, entering cooldown");
            this._AP.state = "cooldown";
            this.apClearTimers();
            this._clearNavigation("ap-cooldown");
            this._cleanup();
            if (this.ws) {
                try {
                    this.ws.close();
                } catch (e) {}
                this.ws = null;
            }
            const waitMs = 10 * 60 * 1000 + Math.floor(Math.random() * 3 * 60 * 1000);
            this.apLog(`Cooldown: ${Math.round(waitMs / 60000)} min`);
            this._AP.cooldownTimer = setTimeout(() => {
                if (!this._AP.active) return;
                this._AP.serverIndex = 0;
                this._AP.pinkyFailCount = 0;
                this.apLog("Cooldown done, restarting loop");
                const srv = this._AP.servers[0];
                if (!srv) {
                    this.apStop();
                    return;
                }
                this._AP.state = "next_server";
                this.switchBotServer(srv.region, srv.biome);
            }, waitMs);
            return;
        }
        // Pace the patrol: rapid consecutive handshakes from one IP trip the server's
        // invalidProtocol kick. Dwell a few seconds between server switches.
        const srv = this._AP.servers[this._AP.serverIndex];
        if (!srv) {
            this.apStop();
            return;
        }
        this.apLog(`→ ${srv.region}-${srv.biome} (${this._AP.serverIndex + 1}/${this._AP.servers.length})`);
        this._AP.state = "next_server";
        const dwellMs = immediate ? 0 : 1000; // brief pacing only; self-switch/kick races are fixed
        this._AP.buildSwitchTimeout = setTimeout(() => {
            if (!this._AP.active) return; // AP stopped while waiting
            this.switchBotServer(srv.region, srv.biome);
        }, dwellMs);
    }
    apOnLogin() {
        const tag = `[${this.accountId.slice(0, 8)}]`;
        if (!this._AP.active || this._AP.state !== "next_server") {
            console.log(`${tag} [AP] apOnLogin skip: active=${this._AP.active} state=${this._AP.state}`);
            return;
        }
        const routeKey = `${this.biomeName}-${this.mapName}`;
        const wp = this._AP.routes[routeKey];
        if (!wp || wp.length === 0) {
            this.apLog(`Skip: ${routeKey} (no route)`);
            this._AP.serverIndex++;
            return;
        }
        this.apLog(`Route: ${routeKey} (${wp.length} waypoints)`);
        this._AP.servers[this._AP.serverIndex].waypoints = wp;
        this._AP.servers[this._AP.serverIndex].routeKey = routeKey;
    }
    apOnSpawned() {
        const tag = `[${this.accountId.slice(0, 8)}]`;
        console.log(`${tag} [AP] apOnSpawned: active=${this._AP.active} state=${this._AP.state}`);
        if (!this._AP.active) return;
        // A server switch is in flight — this spawn is still on the OLD server
        // (game auto-respawn races the switch). Ignore; the new server will
        // spawn us again and this runs with fresh biomeName/mapName.
        if (this._switching) {
            console.log(`${tag} [AP] apOnSpawned ignored: switch in flight`);
            return;
        }
        if (this._AP.state === "next_server") {
            const routeKey = `${this.biomeName}-${this.mapName}`;
            const wp = this._AP.routes[routeKey];
            if (!wp || wp.length === 0) {
                this.apLog(`No route for ${routeKey}, skip`);
                this._AP.serverIndex++;
                this.apAdvance();
                return;
            }
            this._AP.servers[this._AP.serverIndex].waypoints = wp;
            this._AP.servers[this._AP.serverIndex].routeKey = routeKey;
            this._AP.state = "pinky_build";
            this.apLog(`Equipping pinky build`);
            this._equipBuild("pinky");
            this.apClearTimers();
            this._AP.pinkyTimeout = setTimeout(() => {
                if (!this._AP.active || this._AP.state !== "wait_pinky") return;
                this._AP.pinkyFailCount++;
                if (this._AP.pinkyFailCount >= 3) {
                    this._AP.serverIndex++;
                    this.apAdvance();
                } else {
                    this._triggerDeath();
                }
            }, 60000);
        } else if (this._AP.state === "pinky_build") {
            if (this.isPinky) {
                this._AP.state = "move_build";
                this.apLog(`Pinky detected, equipping move build`);
                this._equipBuild("move");
            } else {
                this._AP.state = "wait_pinky";
                this.apLog(`Waiting for pinky`);
            }
        } else if (this._AP.state === "move_build") {
            this._AP.state = "patrolling";
            this._AP.pinkyFailCount = 0;
            this.apLog(`Patrolling`);
            this.apClearTimers();
            this._AP.patrolTimeout = setTimeout(() => {
                if (!this._AP.active || this._AP.state !== "patrolling") return;
                this.apLog("Patrol timeout (10min) → next server");
                this._clearNavigation("ap-patrol-timeout");
                this._AP.serverIndex++;
                this.apAdvance();
            }, 600000);
            const srv = this._AP.servers[this._AP.serverIndex];
            if (srv?.waypoints?.length > 0) {
                this._setRoute(srv.waypoints, "ap-patrol-start");
            } else {
                this._AP.serverIndex++;
                this.apAdvance();
            }
        }
    }
    apOnPinkyState(nowPinky) {
        if (!this._AP.active || !nowPinky) return;
        if (this._AP.state === "wait_pinky" || this._AP.state === "pinky_build") {
            this.apClearTimers();
            this._AP.state = "move_build";
            this.apLog(`Pinky detected, equipping move build`);
            this._equipBuild("move");
            this._AP.state = "patrolling";
            this._AP.pinkyFailCount = 0;
            this.apLog(`Patrolling`);
            this._AP.patrolTimeout = setTimeout(() => {
                if (!this._AP.active || this._AP.state !== "patrolling") return;
                this.apLog("Patrol timeout (10min) → next server");
                this._clearNavigation("ap-patrol-timeout");
                this._AP.serverIndex++;
                this.apAdvance();
            }, 600000);
            const srv = this._AP.servers[this._AP.serverIndex];
            if (srv?.waypoints?.length > 0) {
                this._setRoute(srv.waypoints, "ap-patrol-start-pinky");
            } else {
                this._AP.serverIndex++;
                this.apAdvance();
            }
        }
    }
    apOnDeath() {
        if (!this._AP.active) return;
        if (this._AP.state === "wait_pinky") {
            this.apClearTimers();
            // pinkyFailCount is already incremented by the 60s wait_pinky timeout that
            // triggered this death (via _triggerDeath) — death itself does not count again.
            if (this._AP.pinkyFailCount >= 3) {
                this._AP.serverIndex++;
                this.apAdvance();
            }
        } else if (this._AP.state === "patrolling") {
            this.apClearTimers();
            this.apLog("Death during patrol → next server");
            this._clearNavigation("ap-death");
            this._AP.serverIndex++;
            // Switch immediately — the game auto-respawns us on the old server
            // (opcode 5 → _sendSpawn) unless we move before the respawn lands.
            this.apAdvance(true);
        }
    }
    apOnRouteComplete() {
        if (!this._AP.active || this._AP.state !== "patrolling") return;
        this.apLog("Route complete! Next server");
        this._AP.serverIndex++;
        this.apAdvance(true);
    }
    _triggerDeath() {
        if (!this.isDead && !this.respawnState) {
            this.isDead = true;
            this.isSpawned = false;
            this._clearNavigation("trigger-death");
            this.respawnState = "die_sent";
            this._sendDie();
        }
    }
}
export const BotAutopatrol = _BotAutopatrol.prototype;
