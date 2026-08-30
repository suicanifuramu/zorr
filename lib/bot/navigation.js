// navigation.js — path computation (A* over the map grid), stuck/frantic
// recovery, mob-block handling, and the per-tick navigation driver.
// ponytail: mixins are copied onto BotSession.prototype; full typing blocked on 285 this-props errors, revisit when Phase 7 completes
// @ts-nocheck
import { MinHeap, CENTER_COST, _FRANTIC_DIRS, _FRANTIC_MAX_MS } from "./protocol.js";

/** BotSession navigation methods. Copied onto BotSession.prototype by bot_session.js. */
class _BotNavigable {
    constructor() {
        /** @type {any} */ this.botX;
    }
    // ── Navigation ──
    _resetStuck() {
        this._stuckCellKey = null;
        this._franticMode = false;
        this._franticStartedAt = 0;
        this._mobBlockDetouring = false;
        this._mobBlockWPKey = "";
        this._mobBlockDefendUntil = 0;
    }

    _clearNavigation(reason = "") {
        this.navRoute = [];
        this.navRouteIndex = 0;
        this.navPath = [];
        this.navWaypointIndex = 0;
        this.navigateTarget = null;
        this.lastComputeCell = null;
        this._resetStuck();
        if (reason) console.log(`[${this.accountId.slice(0, 8)}] [Nav] cleared: ${reason}`);
    }

    _setNavigateTarget(target, reason = "") {
        if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return false;
        this.navigateTarget = { x: target.x, y: target.y };
        this.navPath = [];
        this.navWaypointIndex = 0;
        this.lastComputeCell = null;
        this._resetStuck();
        this._computePath();
        if (reason)
            console.log(
                `[${this.accountId.slice(0, 8)}] [Nav] target set: ${reason} -> ${Math.round(target.x)},${Math.round(target.y)} path=${this.navPath.length}`
            );
        return this.navPath.length > 0;
    }

    _setRoute(route, reason = "") {
        if (!Array.isArray(route) || route.length === 0) {
            this._clearNavigation(reason || "empty-route");
            return false;
        }
        this._clearNavigation(reason || "set-route");
        this.navRoute = route;
        this.navRouteIndex = 0;
        const ok = this._setNavigateTarget(route[0], reason || "route-start");
        if (!ok) return this._advanceRouteWaypoint("route-start-no-path");
        return true;
    }

    _advanceRouteWaypoint(reason = "") {
        this._mobBlockDefending = false;
        this._mobBlockDetouring = false;
        this._mobBlockWPKey = "";
        this._mobBlockDefendUntil = 0;
        this.navPath = [];
        this.navWaypointIndex = 0;
        this.navigateTarget = null;
        this.lastComputeCell = null;
        this._resetStuck();

        if (!this.navRoute.length) {
            this._sendMovement(0, 0);
            return false;
        }

        this.navRouteIndex++;
        if (this.navRouteIndex >= this.navRoute.length) {
            this.navRoute = [];
            this.navRouteIndex = 0;
            this.apOnRouteComplete();
            this._sendMovement(0, 0);
            return false;
        }

        const next = this.navRoute[this.navRouteIndex];
        const ok = this._setNavigateTarget(next, reason || "route-advance");
        if (!ok) {
            console.log(
                `[${this.accountId.slice(0, 8)}] [Nav] no path to waypoint ${this.navRouteIndex + 1}, skipping`
            );
            return this._advanceRouteWaypoint("route-skip-no-path");
        }
        return true;
    }

    _computePath() {
        if (!this.mapGrid || !this.navigateTarget) return;
        const cSize = this.serverMapSize / this.gridWidth;
        const sx = Math.floor(this.botX / cSize),
            sy = Math.floor(this.botY / cSize);
        let ex = Math.floor(this.navigateTarget.x / cSize),
            ey = Math.floor(this.navigateTarget.y / cSize);
        const rows = this.mapGrid.length,
            cols = this.mapGrid[0].length;
        if (sx < 0 || sx >= cols || sy < 0 || sy >= rows) {
            this.navPath = [];
            return;
        }
        ex = Math.max(0, Math.min(cols - 1, ex));
        ey = Math.max(0, Math.min(rows - 1, ey));
        if (this.mapGrid[ey][ex] === 0) {
            let found = false,
                bestDist = Infinity,
                bx = ex,
                by = ey;
            for (let r = -2; r <= 2; r++)
                for (let c = -2; c <= 2; c++) {
                    const ny = ey + r,
                        nx = ex + c;
                    if (ny >= 0 && ny < rows && nx >= 0 && nx < cols && this.mapGrid[ny][nx] === 1) {
                        const d = Math.hypot(nx - ex, ny - ey);
                        if (d < bestDist) {
                            bestDist = d;
                            bx = nx;
                            by = ny;
                            found = true;
                        }
                    }
                }
            if (found) {
                ex = bx;
                ey = by;
            } else {
                this.navPath = [];
                return;
            }
        }
        const key = (x, y) => x + "," + y;
        const startKey = key(sx, sy),
            endKey = key(ex, ey);
        if (startKey === endKey) {
            this.navPath = [];
            return;
        }
        const open = new MinHeap();
        open.push({ x: sx, y: sy, f: 0, g: 0 });
        const openSet = new Set([startKey]),
            closedSet = new Set(),
            cameFrom = {},
            gScore = { [startKey]: 0 };
        let found = false,
            iterations = 0;
        while (open.size > 0 && iterations++ < 50000) {
            const cur = open.pop();
            const ck = key(cur.x, cur.y);
            if (closedSet.has(ck)) continue;
            closedSet.add(ck);
            if (ck === endKey) {
                found = true;
                break;
            }
            for (let dy = -1; dy <= 1; dy++)
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = cur.x + dx,
                        ny = cur.y + dy;
                    if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
                    if (this.mapGrid[ny][nx] === 0) continue;
                    if (dx !== 0 && dy !== 0 && (this.mapGrid[cur.y][nx] === 0 || this.mapGrid[ny][cur.x] === 0))
                        continue;
                    const nk = key(nx, ny);
                    if (closedSet.has(nk)) continue;
                    const bc = dx !== 0 && dy !== 0 ? 1.414 : 1;
                    const wd = this._distanceMap ? this._distanceMap[ny][nx] : 10;
                    const mc = bc + CENTER_COST / (wd + 1);
                    const g = gScore[ck] + mc;
                    if (g < (gScore[nk] ?? Infinity)) {
                        cameFrom[nk] = ck;
                        gScore[nk] = g;
                        open.push({ x: nx, y: ny, f: g + Math.hypot(ex - nx, ey - ny), g });
                    }
                }
        }
        if (!found) {
            this.navPath = [];
            return;
        }
        const path = [];
        let cur = endKey;
        while (cur) {
            const [cx, cy] = cur.split(",").map(Number);
            path.push([cx, cy]);
            cur = cameFrom[cur];
        }
        path.reverse();
        this._stuckCellKey = null;
        this.navPath = path;
        let closestIdx = 0,
            closestDist = Infinity;
        for (let i = 0; i < path.length; i++) {
            const d = Math.abs(path[i][0] - sx) + Math.abs(path[i][1] - sy);
            if (d < closestDist) {
                closestDist = d;
                closestIdx = i;
            }
        }
        this.navWaypointIndex = closestIdx;
        this.lastComputeCell = sx + "," + sy;
    }

    _recomputePathIfNavigating() {
        if (!this.navigateTarget || this.navPath.length === 0 || this._mobBlockDetouring) return;
        const cSize = this.serverMapSize / this.gridWidth;
        const sx = Math.floor(this.botX / cSize),
            sy = Math.floor(this.botY / cSize);
        const k = sx + "," + sy;
        if (this.lastComputeCell === k) return;
        this.lastComputeCell = k;
        this._computePath();
    }

    _isCellBlockedByMob(cellX, cellY, cSize) {
        if (!this.activeMobs.size) return false;
        const cmx = cellX * cSize,
            cmy = cellY * cSize,
            cMx = (cellX + 1) * cSize,
            cMy = (cellY + 1) * cSize;
        for (const mob of this.activeMobs.values()) {
            const r = mob.size || 0;
            if (r <= 0) continue;
            if (cmx >= mob.x - r && cMx <= mob.x + r && cmy >= mob.y - r && cMy <= mob.y + r) return true;
        }
        return false;
    }

    _wallAwareMove(desiredVX, desiredVY, cx, cy) {
        if (!this.mapGrid || !this.mapGrid[0]) return { vx: desiredVX, vy: desiredVY };
        const checkX = cx + (desiredVX > 0.3 ? 1 : desiredVX < -0.3 ? -1 : 0);
        const checkY = cy + (desiredVY > 0.3 ? 1 : desiredVY < -0.3 ? -1 : 0);
        const rows = this.mapGrid.length,
            cols = this.mapGrid[0].length;
        if (checkX >= 0 && checkX < cols && checkY >= 0 && checkY < rows && this.mapGrid[checkY][checkX] === 1) {
            const dcx = checkX - cx,
                dcy = checkY - cy;
            if (dcx === 0 || dcy === 0 || (this.mapGrid[cy][checkX] === 1 && this.mapGrid[checkY][cx] === 1))
                return { vx: desiredVX, vy: desiredVY };
        }
        const dirs = [
            [1, 0],
            [0, 1],
            [-1, 0],
            [0, -1],
            [1, 1],
            [-1, 1],
            [1, -1],
            [-1, -1],
        ];
        let bestDot = -Infinity,
            bestDir = null;
        for (const [dx, dy] of dirs) {
            const nx = cx + dx,
                ny = cy + dy;
            if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
            if (this.mapGrid[ny][nx] === 0) continue;
            if (dx !== 0 && dy !== 0 && (this.mapGrid[cy][nx] === 0 || this.mapGrid[ny][cx] === 0)) continue;
            const dlen = Math.hypot(dx, dy) || 1;
            const dot = (dx / dlen) * desiredVX + (dy / dlen) * desiredVY;
            if (dot > bestDot) {
                bestDot = dot;
                bestDir = [dx / dlen, dy / dlen];
            }
        }
        return bestDir ? { vx: bestDir[0], vy: bestDir[1] } : { vx: desiredVX, vy: desiredVY };
    }

    _findNearestWallDir(cx, cy) {
        const dir = [
            [0, -1],
            [1, -1],
            [1, 0],
            [1, 1],
            [0, 1],
            [-1, 1],
            [-1, 0],
            [-1, -1],
        ];
        let bestDist = Infinity,
            bestVX = 1,
            bestVY = 0;
        for (let dr = 1; dr <= 3; dr++)
            for (const [dx, dy] of dir) {
                const nx = cx + dx * dr,
                    ny = cy + dy * dr;
                if (nx < 0 || nx >= this.gridWidth || ny < 0 || ny >= this.gridWidth) continue;
                if (this.mapGrid[ny][nx] === 1 && dr < bestDist) {
                    bestDist = dr;
                    bestVX = -dx;
                    bestVY = -dy;
                }
            }
        const len = Math.sqrt(bestVX * bestVX + bestVY * bestVY) || 1;
        return { vx: bestVX / len, vy: bestVY / len };
    }

    _navigateTick() {
        // Defend phase: try to push through a blocked cell before attempting detour
        if (this._mobBlockDefending) {
            if (Date.now() < this._mobBlockDefendUntil && this.navigateTarget) {
                this._corruptInvert = false;
                for (const mob of this.activeMobs.values()) {
                    if (mob.variant === 5) {
                        this._corruptInvert = true;
                        break;
                    }
                }
                const cSize = this.serverMapSize / this.gridWidth;
                const dx = this.navigateTarget.x - this.botX,
                    dy = this.navigateTarget.y - this.botY;
                const dist = Math.hypot(dx, dy) || 1;
                const wd = this._wallAwareMove(
                    dx / dist,
                    dy / dist,
                    Math.floor(this.botX / cSize),
                    Math.floor(this.botY / cSize)
                );
                this._sendMovement(wd.vx, wd.vy, 2);
                return;
            }
            // Defend time expired; check if cell is still blocked
            this._mobBlockDefending = false;
            if (this.navigateTarget) {
                const cSize = this.serverMapSize / this.gridWidth;
                const tgtCX = Math.floor(this.navigateTarget.x / cSize),
                    tgtCY = Math.floor(this.navigateTarget.y / cSize);
                if (this._isCellBlockedByMob(tgtCX, tgtCY, cSize)) {
                    // Defend failed → switch to detour
                    this._mobBlockDetouring = true;
                    const pv = this.mapGrid[tgtCY][tgtCX];
                    this.mapGrid[tgtCY][tgtCX] = 0;
                    this._computePath();
                    this.mapGrid[tgtCY][tgtCX] = pv;
                    if (this.navPath.length === 0) {
                        console.log(`[MobBlock] No detour after defend, skip WP cell ${tgtCX},${tgtCY}`);
                        this._advanceRouteWaypoint("mob-block-skip");
                        return;
                    }
                    console.log(`[MobBlock] Detour found after defend for cell ${tgtCX},${tgtCY}`);
                } else {
                    this._mobBlockWPKey = "";
                }
            }
        }
        if (
            !this.isSpawned ||
            (!this.navPath.length && !this.navRoute.length) ||
            (!this.navigateTarget && this.navRoute.length === 0)
        ) {
            this._sendMovement(0, 0);
            return;
        }

        this._corruptInvert = false;
        for (const mob of this.activeMobs.values()) {
            if (mob.variant === 5) {
                this._corruptInvert = true;
                break;
            }
        }
        const cSize = this.serverMapSize / this.gridWidth;
        const botCX = Math.floor(this.botX / cSize),
            botCY = Math.floor(this.botY / cSize);
        const cellKey = botCX + "," + botCY,
            now = Date.now();

        // Frantic mode
        if (this._franticMode) {
            if (this._franticStartedAt && now - this._franticStartedAt > _FRANTIC_MAX_MS) {
                console.log(`[${this.accountId.slice(0, 8)}] [Nav] frantic timeout, skipping current waypoint`);
                this._franticMode = false;
                if (this.navRoute.length > 0) {
                    this._advanceRouteWaypoint("frantic-timeout");
                    return;
                }
                this._clearNavigation("frantic-timeout");
                this._sendMovement(0, 0);
                return;
            }
            if (Math.abs(botCX - this._franticOriginCX) >= 2 || Math.abs(botCY - this._franticOriginCY) >= 2) {
                this._franticMode = false;
                this._franticStartedAt = 0;
                this._stuckCellKey = cellKey;
                this._stuckSince = now;
                if (this.navigateTarget) this._computePath();
            } else {
                if (now >= this._franticDirEnd) {
                    this._franticDirIndex = (this._franticDirIndex + 1) % _FRANTIC_DIRS.length;
                    this._franticDirEnd = now + 300 + Math.random() * 500;
                }
                const d = _FRANTIC_DIRS[this._franticDirIndex];
                this._sendMovement(d[0], d[1], 2);
                return;
            }
        }
        if (this.navPath.length > 0 || this.navRoute.length > 0) {
            if (cellKey === this._stuckCellKey) {
                if (now - this._stuckSince > 3000) {
                    this._franticMode = true;
                    this._franticOriginCX = botCX;
                    this._franticOriginCY = botCY;
                    this._franticStartedAt = now;
                    this._franticDirIndex = 0;
                    this._franticDirEnd = now + 300 + Math.random() * 500;
                    this._stuckCellKey = null;
                    this._sendMovement(_FRANTIC_DIRS[0][0], _FRANTIC_DIRS[0][1], 2);
                    return;
                }
            } else {
                this._stuckCellKey = cellKey;
                this._stuckSince = now;
            }
        } else {
            this._stuckCellKey = null;
            this._stuckSince = now;
        }

        // Route patrol
        if (this.navRoute.length > 0 && this.navRouteIndex < this.navRoute.length && !this._mobBlockDetouring) {
            const target = this.navRoute[this.navRouteIndex];
            const tCX = Math.floor(target.x / cSize),
                tCY = Math.floor(target.y / cSize);
            if (Math.abs(botCX - tCX) <= 1 && Math.abs(botCY - tCY) <= 1) {
                this._advanceRouteWaypoint("route-cell-arrived");
                return;
            }
            if (
                !this.navigateTarget ||
                !this.navPath.length ||
                Math.abs(this.navigateTarget.x - target.x) > 1 ||
                Math.abs(this.navigateTarget.y - target.y) > 1
            ) {
                this._setNavigateTarget(target, "route-sync");
            }
        }

        // Mob-blocking: defend first, then detour
        if (this.navigateTarget && this.navRoute.length > 0 && !this._mobBlockDefending && !this._mobBlockDetouring) {
            const tgtCX = Math.floor(this.navigateTarget.x / cSize),
                tgtCY = Math.floor(this.navigateTarget.y / cSize);
            const wpKey = tgtCX + "," + tgtCY;
            if (this._isCellBlockedByMob(tgtCX, tgtCY, cSize)) {
                if (this._mobBlockWPKey !== wpKey) {
                    this._mobBlockWPKey = wpKey;
                    this._mobBlockDefending = true;
                    this._mobBlockDefendUntil = Date.now() + 1000;
                    console.log(`[MobBlock] Defending for 1s at ${wpKey}`);
                }
            } else {
                this._mobBlockWPKey = "";
            }
        }

        if (!this.navPath.length || !this.navigateTarget) {
            this._sendMovement(0, 0);
            return;
        }
        const wp = this.navPath[this.navWaypointIndex];
        const tgtCX = Math.floor(this.navigateTarget.x / cSize),
            tgtCY = Math.floor(this.navigateTarget.y / cSize);
        if (Math.abs(botCX - tgtCX) <= 1 && Math.abs(botCY - tgtCY) <= 1) {
            if (this.navRoute.length > 0) {
                this._advanceRouteWaypoint("target-cell-arrived");
                return;
            }
            this._clearNavigation("target-cell-arrived");
            this._sendMovement(0, 0);
            return;
        }
        if (Math.abs(botCX - wp[0]) <= 1 && Math.abs(botCY - wp[1]) <= 1) {
            this.navWaypointIndex++;
            if (this.navWaypointIndex >= this.navPath.length) {
                if (this.navRoute.length > 0) {
                    this._advanceRouteWaypoint(this._mobBlockDetouring ? "detour-complete" : "path-complete");
                    return;
                }
                this._clearNavigation("path-complete");
                this._sendMovement(0, 0);
                return;
            }
            const nwp = this.navPath[this.navWaypointIndex];
            const nwx = (nwp[0] + 0.5) * cSize,
                nwy = (nwp[1] + 0.5) * cSize;
            const ndx = nwx - this.botX,
                ndy = nwy - this.botY;
            const len = Math.hypot(ndx, ndy) || 1;
            const wd = this._wallAwareMove(ndx / len, ndy / len, botCX, botCY);
            this._sendMovement(wd.vx, wd.vy);
            return;
        }
        const wx = (wp[0] + 0.5) * cSize,
            wy = (wp[1] + 0.5) * cSize;
        const ddx = wx - this.botX,
            ddy = wy - this.botY;
        const ddist = Math.hypot(ddx, ddy) || 1;
        const wdd = this._wallAwareMove(ddx / ddist, ddy / ddist, botCX, botCY);
        this._sendMovement(wdd.vx, wdd.vy);
    }
}
export const BotNavigable = _BotNavigable.prototype;
