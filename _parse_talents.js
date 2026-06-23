const src = require('fs').readFileSync('C:/Users/chanhina/Documents/py-test/zorr-extension/old-source-3/zorr-deobfuscated.js', 'utf8');

// Extract eb string (talent definitions with tree structure)
const ebRe = /var eb = "([\s\S]*?)";/;
const ebMatch = src.match(ebRe);
if (!ebMatch) { console.log('eb not found'); process.exit(1); }
const eb = ebMatch[1].replace(/\\n/g, '\n');

// Extract ed string (ID ordering) - it follows "var ed = {};"
const edRe = /var ed = \{\};\s*\n\s*"([\s\S]*?)"/;
const edMatch = src.match(edRe);
if (!edMatch) { console.log('ed not found'); process.exit(1); }
const ed = edMatch[1].replace(/\\n/g, '\n');

// Parse ed to get slug -> id mapping (line order = id)
const edLines = ed.split('\n').filter(l => l.trim());
const slugToId = {};
edLines.forEach((line, idx) => {
    const parts = line.trim().split(/\s+/);
    if (parts[0]) slugToId[parts[0]] = idx;
});

// Parse eb to get talent tree structure
const ebLines = eb.split('\n').filter(l => l.trim());
const talents = [];
const stack = []; // stack of [depth, id]

for (const line of ebLines) {
    const m = line.match(/^(-*)(\w+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/);
    if (!m) continue;
    const depth = m[1].length;
    const slug = m[2];
    const cost = parseFloat(m[3]);
    const value = parseFloat(m[4]);
    const id = slugToId[slug] !== undefined ? slugToId[slug] : talents.length;

    // Find parent (previous talent with depth-1)
    let parentId = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i][0] === depth - 1) {
            parentId = stack[i][1];
            break;
        }
    }

    talents.push({ id, slug, cost, value, parentId });
    stack.push([depth, id]);
}

// Sort by id (matching game's sort order)
talents.sort((a, b) => a.id - b.id);

console.log('Total talents:', talents.length);
console.log('First 5:', JSON.stringify(talents.slice(0, 5), null, 2));
console.log('Last 5:', JSON.stringify(talents.slice(-5), null, 2));

// Output as module
const out = ['module.exports = ['];
for (const t of talents) {
    out.push(`    { id: ${t.id}, slug: "${t.slug}", cost: ${t.cost}, value: ${t.value}, parentId: ${t.parentId} },`);
}
out.push('];');
require('fs').writeFileSync('C:/Users/chanhina/Documents/py-test/zorr-extension/websocket/talent_data.js', out.join('\n'));
console.log('Written to talent_data.js');
