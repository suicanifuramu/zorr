# Pathfinding.js 中央寄り経路探索 実装ガイド

## 現状の問題

通常の A* は

- 最短距離
- 最小移動回数

のみを評価する。

そのため道幅が広い場所でも、

- 壁沿い
- 通路の端

を通ることがある。

---

## 目標

以下のような経路を生成する。

### 現状

```text
################

S.............G
############....
```

壁沿いを通る。

---

### 目標

```text
################

....S.......G...
############....
```

通路の中央を通る。

---

# アルゴリズム概要

## Step1

PNGから通行マップ生成

```js
0 = 通行可能
1 = 壁
```

例

```text
111111111
100000001
100000001
111111111
```

---

## Step2

壁からの距離マップを生成

各マスについて

```text
最も近い壁までの距離
```

を保持する。

例

```text
111111111
122222221
123333321
122222221
111111111
```

数字が大きいほど中央。

---

## Step3

距離マップを BFS で生成

### 初期化

全壁をキューへ投入

```js
dist[y][x] = 0;
```

---

### BFS

上下左右へ拡散

```js
dist[next] = dist[current] + 1;
```

---

### 実装

```js
function buildDistanceMap() {
    const dist = Array.from({ length: map.height }, () => Array(map.width).fill(Infinity));

    const queue = [];

    for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
            if (map.grid[y][x] === 1) {
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
            const nx = x + dx;
            const ny = y + dy;

            if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) {
                continue;
            }

            if (dist[ny][nx] > dist[y][x] + 1) {
                dist[ny][nx] = dist[y][x] + 1;

                queue.push([nx, ny]);
            }
        }
    }

    return dist;
}
```

---

# Step4

独自 A* を実装

Pathfinding.js は

```text
移動コスト固定
```

なので中央優先ができない。

そのため自前で A* を実装する。

---

## 通常コスト

```js
moveCost = 1;
```

---

## 中央寄りコスト

```js
moveCost = 1 + 20 / (distanceMap[y][x] + 1);
```

---

### 例

壁から1マス

```text
distance=1

cost=11
```

---

壁から10マス

```text
distance=10

cost=2.8
```

---

壁から20マス

```text
distance=20

cost=1.95
```

---

結果

```text
壁沿い
↓
高コスト

中央
↓
低コスト
```

となる。

---

# Step5

ヒューリスティック

ゴールまでの距離

```js
function heuristic(x, y, endX, endY) {
    return Math.hypot(endX - x, endY - y);
}
```

---

# Step6

評価値

```js
f = g + h;
```

g

```text
開始地点からのコスト
```

h

```text
ゴールまでの推定距離
```

---

# Step7

経路復元

親ノードを保持

```js
parent[y][x];
```

から逆順に辿る。

---

# Step8

経路平滑化

探索後

```js
PF.Util.compressPath();
```

または

```js
PF.Util.smoothenPath();
```

を適用。

---

# 推奨パラメータ

## 弱い中央寄せ

```js
1 + 5 / (distance + 1);
```

---

## 標準

```js
1 + 20 / (distance + 1);
```

---

## 強い中央寄せ

```js
1 + 50 / (distance + 1);
```

---

# 最終構成

```text
map.png
 ↓

map.json
 ↓

buildDistanceMap()
 ↓

distanceMap
 ↓

Custom A*
 ↓

compressPath()
 ↓

smoothenPath()
 ↓

描画
```

この構成にすると、ゲームの NPC やナビゲーションメッシュに近い自然な「通路中央寄り」の経路になる。
