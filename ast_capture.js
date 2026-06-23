/**
 * ast_capture.js
 *
 * Uses acorn to find candidate variable declarations in the obfuscated
 * Zorr game source. Injects getter-based capture code after each candidate
 * so that, when the source is run in a VM, the runtime values of those
 * variables are exposed on globalThis.__zorr_<name>.
 *
 * The capture mechanism uses Object.defineProperty with a getter:
 *   Object.defineProperty(globalThis, '__zorr_X', {
 *     get: () => X, configurable: true
 *   });
 * This works for local-scope variables because the getter is a closure
 * defined in the same scope as X.
 */
const acorn = require('acorn');

/**
 * Walk the AST and collect candidate variable declarations. A candidate is
 * any VariableDeclarator whose init is:
 *   - ArrayExpression with >= 5 elements
 *   - ObjectExpression with >= 5 properties
 *   - CallExpression whose first arg is an ObjectExpression with >= 5 props
 *   - Identifier referring to a FunctionDeclaration (e.g. `const Od = Cr;`)
 *     — used to expose string-lookup functions in the live source so we
 *     can resolve `Od(1234)`-style obfuscated string references.
 *
 * To avoid capturing hundreds of harmless aliases, func-alias candidates
 * are restricted to names with exactly 2 characters (typical obfuscation
 * pattern) and only added when the obfuscation call pattern
 * `Name(<numeric literal>)` is observed somewhere in the source.
 *
 * Returns array of {name, declEnd, initKind, initLen}.
 */
function findCandidates(source) {
    const ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: 'script' });
    const candidates = [];
    // Pass 1: collect all top-level FunctionDeclaration names.
    const funcNames = new Set();
    const collectFuncs = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { for (const x of node) collectFuncs(x); return; }
        if (node.type === 'FunctionDeclaration' && node.id) {
            funcNames.add(node.id.name);
        }
        for (const k of Object.keys(node)) {
            if (k === 'loc' || k === 'start' || k === 'end' || k === 'type'
                || k === 'range' || k === 'raw' || k === 'comments') continue;
            collectFuncs(node[k]);
        }
    };
    collectFuncs(ast);
    // Pass 1b: find the 2-character names that have at least one call site
    // of the form `Name(<numeric literal>)` in the source. We probe EVERY
    // 2-char identifier (var, func, anything), since the alias and the
    // original function may differ in name (e.g. `const Od = Cr;` where
    // call sites use `Od` not `Cr`).
    const obfCallNames = new Set();
    const re2 = /\b([A-Za-z_$][\w$]{1,2})\s*\(\s*\d+\s*\)/g;
    let m;
    while ((m = re2.exec(source)) !== null) {
        if (m[1].length === 2) obfCallNames.add(m[1]);
    }

    const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { for (const x of node) walk(x); return; }
        if (node.type === 'VariableDeclaration') {
            for (const d of node.declarations) {
                if (!d.init) continue;
                const i = d.init;
                if (i.type === 'ArrayExpression' && i.elements.length >= 5) {
                    candidates.push({
                        name: d.id.name,
                        declEnd: node.end,
                        initKind: 'array',
                        initLen: i.elements.length,
                    });
                } else if (i.type === 'ObjectExpression' && i.properties.length >= 5) {
                    candidates.push({
                        name: d.id.name,
                        declEnd: node.end,
                        initKind: 'object',
                        initLen: i.properties.length,
                    });
                } else if (i.type === 'CallExpression' && i.arguments.length >= 1
                    && i.arguments[0].type === 'ObjectExpression'
                    && i.arguments[0].properties.length >= 5) {
                    candidates.push({
                        name: d.id.name,
                        declEnd: node.end,
                        initKind: 'callobj',
                        initLen: i.arguments[0].properties.length,
                    });
                } else if (i.type === 'CallExpression'
                    && i.callee && i.callee.type === 'MemberExpression'
                    && i.callee.object && i.callee.object.type === 'Identifier'
                    && i.callee.object.name === 'JSON'
                    && i.callee.property && i.callee.property.type === 'Identifier'
                    && i.callee.property.name === 'parse'
                    && i.arguments.length >= 1
                    && i.arguments[0].type === 'Literal'
                    && typeof i.arguments[0].value === 'string') {
                    candidates.push({
                        name: d.id.name,
                        declEnd: node.end,
                        initKind: 'jsonparse',
                        initLen: 0,
                    });
                } else if (i.type === 'Identifier'
                    && d.id.type === 'Identifier'
                    && d.id.name.length === 2
                    && i.name.length === 2
                    && obfCallNames.has(i.name)) {
                    // Function alias candidate: const Od = Cr; where both
                    // names are 2 chars and `Cr(NUM)` appears in source.
                    // We capture the ALIAS, so `__zorr_Od` is the same
                    // function reference as Cr.
                    candidates.push({
                        name: d.id.name,
                        declEnd: node.end,
                        initKind: 'func',
                        initLen: 0,
                    });
                }
            }
        }
        for (const k of Object.keys(node)) {
            if (k === 'loc' || k === 'start' || k === 'end' || k === 'type'
                || k === 'range' || k === 'raw' || k === 'comments') continue;
            walk(node[k]);
        }
    };
    walk(ast);
    return candidates;
}

/**
 * Find a FunctionDeclaration by name and return its body AST node.
 * Used to extract statically-initialised data structures (e.g. server list
 * with regions/biomes) without invoking the function — this avoids
 * sandbox side effects from tU's DOM/window dependencies.
 *
 * @param {string} source
 * @param {string} name Function name to look for (e.g. "tU")
 * @returns {object|null} The body BlockStatement node, or null if not found.
 */
function findFunctionBody(source, name) {
    const ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: 'script' });
    let found = null;
    const walk = (node) => {
        if (found) return;
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { for (const x of node) walk(x); return; }
        if (node.type === 'FunctionDeclaration'
            && node.id && node.id.name === name
            && node.body && node.body.type === 'BlockStatement') {
            found = node.body;
            return;
        }
        for (const k of Object.keys(node)) {
            if (k === 'loc' || k === 'start' || k === 'end' || k === 'type'
                || k === 'range' || k === 'raw' || k === 'comments') continue;
            walk(node[k]);
        }
    };
    walk(ast);
    return found;
}

/**
 * Build the capture-injection code for one variable.
 * The closure captures the variable by reference, so it returns the
 * final value after any subsequent mutations.
 */
function captureCode(varName) {
    return `;Object.defineProperty(globalThis,'__zorr_${varName}',{get:()=>${varName},configurable:true});`;
}

/**
 * Inject capture code for all candidates into the source.
 *
 * P6: 1-pass implementation. Build an array of `[head, code1, tail1,
 * code2, tail2, ..., codeN, tailN]` then join once. This avoids the
 * N*M string slicing cost of the previous implementation.
 *
 * @param {string} source The original obfuscated source.
 * @param {Array<{name: string, declEnd: number}>} candidates
 * @returns {string} Modified source.
 */
function injectCaptures(source, candidates) {
    if (candidates.length === 0) return source;
    // Sort by declEnd ASC so the slice points remain valid as we append
    const sorted = [...candidates].sort((a, b) => a.declEnd - b.declEnd);
    const parts = [];
    let cursor = 0;
    for (const c of sorted) {
        parts.push(source.slice(cursor, c.declEnd));
        parts.push(captureCode(c.name));
        cursor = c.declEnd;
    }
    parts.push(source.slice(cursor));
    return parts.join('');
}

module.exports = { findCandidates, findFunctionBody, injectCaptures, captureCode };
