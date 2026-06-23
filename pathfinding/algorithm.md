# 中央寄り経路探索アルゴリズム

## 概要

通常のA*は最短距離のみを評価するため壁沿いを通る。本アルゴリズムでは移動コストに壁からの距離を組み込み、通路中央を通る経路を生成する。

## 処理フロー

```
map.png
  ↓ (convert.js)
map.json
  ↓
buildDistanceMap()  [BFS]
  ↓
distanceMap
  ↓
Custom A*  [距離依存コスト]
  ↓
compressPath()
  ↓
描画
```

---

## Step1: 通行マップ生成

PNG画像から通行マップを生成する。

```js
// convert.js
brightness < 128 ? 1 : 0  // 黒=壁(1), 白=通行(0)
```

出力形式:

```json
{
  "width": 281,
  "height": 275,
  "grid": [[1,1,...],[1,0,...],...]
}
```

---

## Step2: 壁距離マップ（BFS）

各セルについて最も近い壁までの距離を計算する。

```js
function buildDistanceMap() {
    const dist = Array.from(
        { length: map.height },
        () => Array(map.width).fill(Infinity)
    );

    const queue = [];

    // 全壁をキューに投入
    for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
            if (map.grid[y][x] === 1) {
                dist[y][x] = 0;
                queue.push([x, y]);
            }
        }
    }

    // BFSで上下左右に拡散
    let head = 0;
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];

    while (head < queue.length) {
        const [x, y] = queue[head++];

        for (const [dx, dy] of dirs) {
            const nx = x + dx;
            const ny = y + dy;

            if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;

            if (dist[ny][nx] > dist[y][x] + 1) {
                dist[ny][nx] = dist[y][x] + 1;
                queue.push([nx, ny]);
            }
        }
    }

    return dist;
}
```

計算量: O(width × height)

例:

```text
111111111
122222221
123333321
122222221
111111111
```

数字が大きいほど中央。

---

## Step3: 独自A*アルゴリズム

### 移動コスト

```js
moveCost = baseCost + CENTER_COST / (distanceMap[ny][nx] + 1)
```

- `baseCost`: 1（上下左右）または √2（対角）
- `CENTER_COST`: 20（標準）

| 壁距離 | 移動コスト |
|--------|-----------|
| 1      | 11.0      |
| 5      | 4.33      |
| 10     | 2.82      |
| 20     | 1.95      |

壁に近い → 高コスト（回避）、中央 → 低コスト（通過しやすい）

### ヒューリスティック

```js
function heuristic(x, y, endX, endY) {
    return Math.hypot(endX - x, endY - y);
}
```

ユークリッド距離。推定値は実コスト以下になるためアドミシブル。

### 評価値

```js
f = g + h
```

- g: 開始地点からの累積コスト
- h: ゴールまでの推定距離

### 実装

```js
function findPath() {
    const open = new MinHeap();
    const gScore = Array.from(
        { length: map.height },
        () => Array(map.width).fill(Infinity)
    );
    const parent = Array.from(
        { length: map.height },
        () => Array(map.width).fill(null)
    );
    const closed = Array.from(
        { length: map.height },
        () => Array(map.width).fill(false)
    );

    gScore[start.y][start.x] = 0;
    open.push({
        x: start.x,
        y: start.y,
        f: heuristic(start.x, start.y, end.x, end.y)
    });

    const dirs = [
        [1, 0, 1],           // 右
        [-1, 0, 1],          // 左
        [0, 1, 1],           // 下
        [0, -1, 1],          // 上
        [1, 1, Math.SQRT2],  // 右下
        [-1, 1, Math.SQRT2], // 左下
        [1, -1, Math.SQRT2], // 右上
        [-1, -1, Math.SQRT2] // 左上
    ];

    while (open.size > 0) {
        const current = open.pop();

        if (current.x === end.x && current.y === end.y) break;

        if (closed[current.y][current.x]) continue;
        closed[current.y][current.x] = true;

        for (const [dx, dy, baseCost] of dirs) {
            const nx = current.x + dx;
            const ny = current.y + dy;

            if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
            if (map.grid[ny][nx] === 1) continue;
            if (closed[ny][nx]) continue;

            // 対角: 角抜け防止
            if (dx !== 0 && dy !== 0) {
                if (map.grid[current.y][nx] === 1 || map.grid[ny][current.x] === 1) continue;
            }

            const moveCost = baseCost + CENTER_COST / (distanceMap[ny][nx] + 1);
            const tentativeG = gScore[current.y][current.x] + moveCost;

            if (tentativeG < gScore[ny][nx]) {
                gScore[ny][nx] = tentativeG;
                parent[ny][nx] = [current.x, current.y];
                open.push({
                    x: nx,
                    y: ny,
                    f: tentativeG + heuristic(nx, ny, end.x, end.y)
                });
            }
        }
    }

    // 経路復元
    const path = [];
    let cx = end.x, cy = end.y;

    while (cx !== start.x || cy !== start.y) {
        path.push([cx, cy]);
        const p = parent[cy][cx];
        if (!p) return []; // 到達不可
        [cx, cy] = p;
    }

    path.push([start.x, start.y]);
    path.reverse();

    return path;
}
```

---

## Step4: 経路圧縮

```js
const compressed = PF.Util.compressPath(path);
```

同一線上の中間ポイントを除去し、直線区間のみに圧縮する。

---

## 優先度キュー（MinHeap）

```js
class MinHeap {
    constructor() { this.data = []; }

    push(item) {
        this.data.push(item);
        this._bubbleUp(this.data.length - 1);
    }

    pop() {
        const top = this.data[0];
        const last = this.data.pop();
        if (this.data.length > 0) {
            this.data[0] = last;
            this._sinkDown(0);
        }
        return top;
    }

    get size() { return this.data.length; }

    _bubbleUp(i) {
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.data[i].f < this.data[parent].f) {
                [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
                i = parent;
            } else break;
        }
    }

    _sinkDown(i) {
        const n = this.data.length;
        while (true) {
            let smallest = i;
            const left = 2 * i + 1;
            const right = 2 * i + 2;
            if (left < n && this.data[left].f < this.data[smallest].f) smallest = left;
            if (right < n && this.data[right].f < this.data[smallest].f) smallest = right;
            if (smallest !== i) {
                [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
                i = smallest;
            } else break;
        }
    }
}
```

---

## 推奨パラメータ

| 強さ | CENTER_COST |式|
|------|-------------|---|
| 弱い | 5 | `1 + 5 / (distance + 1)` |
| 標準 | 20 | `1 + 20 / (distance + 1)` |
| 強い | 50 | `1 + 50 / (distance + 1)` |

---

## 注意事項

- `smoothenPath()` は使用しない（Bresenham線分補間が中央寄せ経路を破壊する）
- `compressPath()` のみ使用（同一線上の中間点除去のみ）
- 対角移動時は角抜け防止チェックが必要
