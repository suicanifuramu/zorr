/**
 * normalizers.js
 *
 * Convert raw captured values into the v2 schema. Pure data transforms
 * with no VM/fetch/cache concerns — extracted here to avoid a circular
 * dependency between extraction_pipeline and game_data_extractor.
 */
const { detectSnakeProp } = require('./shape_classifier');

function slugify(name) {
    if (typeof name !== 'string') return '';
    return name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function normalizeRarities(items) {
    if (!Array.isArray(items)) return [];
    return items.map((t, idx) => {
        // Tolerant: some captures may have a fully-built object, others the
        // raw tuple. Handle both.
        const name = t.name || t[0];
        const color = t.color || t[1];
        const weight = t.craftRate ?? t[2];
        return {
            id: t.id ?? idx,
            name: String(name || ''),
            color: String(color || ''),
            weight: typeof weight === 'number' ? weight : 0,
            slug: slugify(name),
        };
    }).filter(r => r.name);
}

function normalizeVariants(map) {
    if (!map || typeof map !== 'object') return [];
    const out = [];
    const seen = new Set();
    for (let i = 0; i < (map.length || 0); i++) {
        const name = map[i];
        if (typeof name === 'string' && name.length > 0 && !seen.has(name)) {
            seen.add(name);
            out.push({ id: i, name });
        }
    }
    return out;
}

function normalizePetals(items) {
    if (!Array.isArray(items)) return [];
    return items
        .filter(p => p != null && typeof p === 'object')
        .map((p, idx) => ({
            id: p.id ?? idx,
            name: p.name || '',
            slug: p.slug || slugify(p.name),
            desc: p.desc || p.description || '',
            size: p.size,
            damage: p.damage,
            health: p.health,
            reload: p.reload,
            cost: p.cost,
        })).filter(p => p.name);
}

function normalizeMobs(items) {
    if (!Array.isArray(items)) return [];
    return items
        .filter(m => m != null && typeof m === 'object')
        .map((m, idx) => {
            const snakeHit = detectSnakeProp(m);
            return {
                id: m.id ?? idx,
                name: m.name || '',
                slug: m.slug || slugify(m.name),
                desc: m.desc || m.description || '',
                health: m.health ?? m.maxHealth,
                damage: m.damage,
                armor: m.armor,
                size: m.size,
                isSnake: !!snakeHit,
                snakeProp: snakeHit ? snakeHit.propName : null,
                snakeCount: snakeHit ? snakeHit.value : null,
            };
        }).filter(m => m.name);
}

function normalizeTalents(items) {
    if (!Array.isArray(items)) return [];
    return items
        .filter(t => t != null && typeof t === 'object')
        .map((t, idx) => ({
            id: t.id ?? idx,
            slug: t.slug || '',
            cost: t.cost,
            value: t.value,
            parentId: typeof t.parentId === 'number' ? t.parentId : -1,
        })).filter(t => t.slug);
}

function normalizeBiomeMobs(map) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
    const result = {};
    for (const [biome, mobSet] of Object.entries(map)) {
        if (mobSet && typeof mobSet === 'object' && !Array.isArray(mobSet)) {
            result[biome] = Object.keys(mobSet);
        }
    }
    return result;
}

function computeSnakeIndices(mobs) {
    const out = [];
    for (let i = 0; i < mobs.length; i++) {
        if (mobs[i].isSnake) out.push(i);
    }
    return out;
}

/**
 * Extract region/biome lists statically by searching the entire AST for
 * the structural invariant of the server-selector tabs literal:
 *
 *   const TABS = [
 *     { <itemsProp>: ["eu", "us", "as"] },     // regions
 *     { <itemsProp>: <biomeExpr>, <colorsProp>: <colorExpr> }  // biomes
 *   ];
 *
 * Across obfuscation generations the same logical structure appears
 * with different identifier names: tU/tW, items/[1085], tx/tz, Su/zu.
 * The shape itself (2-element ArrayExpression of ObjectExpressions,
 * the first carrying a string-array property and the second carrying
 * both a string-array/identifier property and a separate color array)
 * is the stable signal.
 *
 * Resolution rules:
 *   - regions.items: must be a literal ArrayExpression of >=2 string literals
 *   - biomes.items: literal ArrayExpression OR Identifier (resolved via
 *     txResolver map<name,string[]>)
 *   - biomes.colors: literal ArrayExpression of hex-color strings, OR
 *     an ArrayExpression of CallExpressions like `Od(5897)` (resolved
 *     via callResolver map<name,function>, applied as `fn(arg)`), OR
 *     an Identifier (resolved via callResolver)
 *
 * @param {object} astNode Root AST node (Program) — searched recursively
 * @param {Map<string,string[]>|null} txResolver Identifier name → string array
 * @param {Map<string,Function>|null} callResolver Identifier name → callable
 *   used to evaluate `Od(1234)`-style references in the live source
 * @returns {{regions: Array, biomes: Array, functionName: string|null}}
 */
function normalizeServerList(astNode, txResolver, callResolver) {
    if (!astNode) return { regions: [], biomes: [], functionName: null };
    txResolver = txResolver || new Map();
    callResolver = callResolver || new Map();

    let best = null; // pick the tabs literal with the most biomes
    const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { for (const x of node) walk(x); return; }
        if (node.type === 'ArrayExpression' && node.elements.length === 2) {
            const [a, b] = node.elements;
            if (!a || !b) return;
            if (a.type !== 'ObjectExpression' || b.type !== 'ObjectExpression') return;
            // First tab: must have one ArrayExpression prop with >=2 string literals
            const tab0ArrProps = a.properties.filter(p =>
                p.value && p.value.type === 'ArrayExpression'
                && p.value.elements.length >= 2
                && p.value.elements.every(e => e && e.type === 'Literal' && typeof e.value === 'string'));
            if (tab0ArrProps.length !== 1) return;
            // Second tab: must have a biome prop (ArrayExpression-of-literals OR
            // Identifier resolvable via txResolver) AND a separate color prop
            // (ArrayExpression of hex strings, or ArrayExpression of
            // `CallExpression(Identifier)` resolvable via callResolver, or
            // Identifier resolvable via callResolver returning an array).
            const tab1BiomeProps = b.properties.filter(p => {
                if (!p.value) return false;
                if (p.value.type === 'Identifier') {
                    return txResolver.has(p.value.name)
                        || callResolver.has(p.value.name);
                }
                if (p.value.type === 'ArrayExpression') {
                    return p.value.elements.every(e =>
                        e && e.type === 'Literal' && typeof e.value === 'string');
                }
                return false;
            });
            const tab1ColorProps = b.properties.filter(p => {
                if (!p.value) return false;
                if (p.value.type === 'Identifier') {
                    const v = callResolver.get(p.value.name);
                    return Array.isArray(v) && v.length >= 5;
                }
                if (p.value.type !== 'ArrayExpression') return false;
                if (p.value.elements.length < 5) return false;
                return p.value.elements.every(e => {
                    if (!e) return false;
                    if (e.type === 'Literal' && typeof e.value === 'string'
                        && /^#[0-9a-f]{6}$/i.test(e.value)) return true;
                    if (e.type === 'CallExpression'
                        && e.callee && e.callee.type === 'Identifier'
                        && callResolver.has(e.callee.name)
                        && e.arguments.length === 1
                        && e.arguments[0].type === 'Literal'
                        && typeof e.arguments[0].value === 'number') return true;
                    return false;
                });
            });
            if (tab1BiomeProps.length === 0 || tab1ColorProps.length === 0) return;

            // Look up the enclosing function name (informational)
            const funcName = _findEnclosingFunctionName(astNode, node) || null;

            // Score: prefer the one with more biomes
            const tab1BiomeProp = tab1BiomeProps[0];
            let biomeCount = 0;
            if (tab1BiomeProp.value.type === 'ArrayExpression') {
                biomeCount = tab1BiomeProp.value.elements.length;
            } else if (tab1BiomeProp.value.type === 'Identifier' && txResolver) {
                const arr = txResolver.get(tab1BiomeProp.value.name);
                if (Array.isArray(arr)) biomeCount = arr.length;
            }
            if (!best || biomeCount > best.biomeCount) {
                best = { tab0Prop: tab0ArrProps[0], tab1BiomeProp, tab1ColorProp: tab1ColorProps[0],
                         biomeCount, funcName };
            }
        }
        for (const k of Object.keys(node)) {
            if (k === 'loc' || k === 'start' || k === 'end' || k === 'type'
                || k === 'range' || k === 'raw' || k === 'comments') continue;
            walk(node[k]);
        }
    };
    walk(astNode);

    if (!best) {
        return { regions: [], biomes: [], functionName: null };
    }

    // Regions
    const regionNames = best.tab0Prop.value.elements
        .map(e => e && e.type === 'Literal' && typeof e.value === 'string' ? e.value : null)
        .filter(n => n);
    const regions = regionNames.map((name, i) => ({ id: i, name, slug: slugify(name) }));

    // Biomes
    let biomeNames = [];
    const bv = best.tab1BiomeProp.value;
    if (bv.type === 'ArrayExpression') {
        biomeNames = bv.elements
            .map(e => e && e.type === 'Literal' && typeof e.value === 'string' ? e.value : null)
            .filter(n => n);
    } else if (bv.type === 'Identifier' && txResolver.has(bv.name)) {
        const arr = txResolver.get(bv.name);
        if (Array.isArray(arr)) biomeNames = arr.filter(n => typeof n === 'string');
    }

    // Colors
    let colors = [];
    const cv = best.tab1ColorProp.value;
    if (cv.type === 'ArrayExpression') {
        for (const e of cv.elements) {
            if (!e) continue;
            if (e.type === 'Literal' && typeof e.value === 'string') {
                colors.push(e.value);
            } else if (e.type === 'CallExpression'
                && e.callee && e.callee.type === 'Identifier'
                && callResolver.has(e.callee.name)
                && e.arguments.length === 1
                && e.arguments[0].type === 'Literal'
                && typeof e.arguments[0].value === 'number') {
                try {
                    const fn = callResolver.get(e.callee.name);
                    const result = fn(e.arguments[0].value);
                    if (typeof result === 'string') colors.push(result);
                    else colors.push(null);
                } catch (_) {
                    colors.push(null);
                }
            } else {
                colors.push(null);
            }
        }
    } else if (cv.type === 'Identifier' && callResolver.has(cv.name)) {
        const arr = callResolver.get(cv.name);
        if (Array.isArray(arr)) colors = arr.slice();
    }

    const biomes = biomeNames
        .map((name, i) => ({
            id: i,
            name,
            slug: slugify(name),
            color: colors[i] || null,
        }));

    return { regions, biomes, functionName: best.funcName };
}

/**
 * Walk parent chain to find the enclosing FunctionDeclaration's name.
 * Cheap O(depth) lookup using a parent map built lazily.
 */
const _parentMapCache = new WeakMap();
function _buildParentMap(root) {
    if (_parentMapCache.has(root)) return _parentMapCache.get(root);
    const map = new Map();
    const walk = (node, parent) => {
        if (!node || typeof node !== 'object') return;
        map.set(node, parent);
        if (Array.isArray(node)) { for (const x of node) walk(x, node); return; }
        for (const k of Object.keys(node)) {
            if (k === 'loc' || k === 'start' || k === 'end' || k === 'type'
                || k === 'range' || k === 'raw' || k === 'comments') continue;
            walk(node[k], node);
        }
    };
    walk(root, null);
    _parentMapCache.set(root, map);
    return map;
}
function _findEnclosingFunctionName(root, target) {
    const map = _buildParentMap(root);
    let n = target;
    while (n) {
        const p = map.get(n);
        if (!p) return null;
        if (p.type === 'FunctionDeclaration' && p.id && p.id.name) return p.id.name;
        n = p;
    }
    return null;
}

module.exports = {
    slugify,
    normalizeRarities,
    normalizeVariants,
    normalizePetals,
    normalizeMobs,
    computeSnakeIndices,
    normalizeTalents,
    normalizeBiomeMobs,
    normalizeServerList,
};
