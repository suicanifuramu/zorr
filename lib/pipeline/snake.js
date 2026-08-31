// snake.js — per-mob snake detection from raw captured arrays.

// Normalize per-mob snake detection (Phase A verified: snakeCount on 9/178 mobs)
// ============================================================================
function extractSnakeIndicesFromRaw(mobs) {
    const indices = [];
    for (let i = 0; i < mobs.length; i++) {
        const m = mobs[i];
        if (m && typeof m === "object" && "snakeCount" in m && typeof m.snakeCount === "number" && m.snakeCount > 0) {
            indices.push(i);
        }
    }
    return indices;
}

export { extractSnakeIndicesFromRaw };
