// The hand-written Tarjan and the palette assignment — model.mjs's two ungated
// pieces.
//
// Both Tarjan failure modes are silent: a wrong merge reports "acyclic ✓" over a
// real cycle, a wrong split reports a cycle that is not there. Its emission ORDER
// reaches output bytes too, through cycComps, into the stdout JSON's sccs arrays
// and the report's cycle lines — but NOT into the matrix, whose layout triOrder
// derives independently and which is invariant under a permutation of comps ids.
// Hand-picked graphs cannot reach any of that; the oracle here is brute-force
// mutual reachability over seeded random digraphs, a free supply of shapes
// nobody would think to draw. The palette cases carry their own argument at the
// point of use.

import test from 'node:test';
import assert from 'node:assert/strict';

import { EMPTY_RAW } from './helpers/fixture.mjs';
import {
  tarjan, distinctInOrder, assemble, NS_SEP, CTX_PALETTE, NS_PALETTE,
} from '../tools/inspector-gadget/model.mjs';

// Numerical Recipes LCG: a failing graph is named by (n, density, seed) in the
// assertion message and rebuilds byte-identically from it.
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// self-loops included (a === b is not skipped) — they are the one case where
// the oracle and the tool's cycle filter deliberately disagree
function digraph(n, density, seed) {
  const rand = lcg(seed);
  const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
  const adj = new Map(nodes.map(v => [v, []]));
  for (const a of nodes) for (const b of nodes) if (rand() < density) adj.get(a).push(b);
  return { nodes, adj };
}

// transitive closure over ONE OR MORE edges, so a node appears in its own
// reachable set only through a genuine cycle
function closure(nodes, adj) {
  const reach = new Map();
  for (const start of nodes) {
    const seen = new Set();
    const queue = [...(adj.get(start) ?? [])];
    while (queue.length > 0) {
      const v = queue.pop();
      if (seen.has(v)) continue;
      seen.add(v);
      for (const w of adj.get(v) ?? []) queue.push(w);
    }
    reach.set(start, seen);
  }
  return reach;
}

const GRAPHS = [];
for (const n of [1, 2, 3, 5, 8, 13, 21, 34]) {
  for (const density of [0, 0.02, 0.08, 0.2, 0.5, 0.9]) {
    for (let k = 0; k < 4; k++) GRAPHS.push({ n, density, seed: n * 10007 + Math.round(density * 100) * 31 + k });
  }
}
const where = (g) => `n=${g.n} density=${g.density} seed=${g.seed}`;

test('the components partition the node set, and size() reads the component that holds the node', () => {
  assert.ok(GRAPHS.length > 0, 'an empty table satisfies every assertion in the loop below without running one');
  let withMulti = 0;
  for (const g of GRAPHS) {
    const { nodes, adj } = digraph(g.n, g.density, g.seed);
    const scc = tarjan(nodes, adj);
    const flat = scc.comps.flat();
    assert.equal(flat.length, nodes.length, `a node emitted twice or dropped — ${where(g)}`);
    assert.deepEqual([...flat].sort(), [...nodes].sort(), `emitted membership is not the node set — ${where(g)}`);
    for (const v of nodes) {
      const ci = scc.id.get(v);
      assert.ok(scc.comps[ci]?.includes(v), `id sends ${v} to a component that does not hold it — ${where(g)}`);
      // the partition above makes the holder unique, so comps can be searched
      // for it without going through id — two routes to one component, not one
      const holder = scc.comps.find(c => c.includes(v));
      assert.ok(holder, `no component in comps holds ${v} — ${where(g)}`);
      assert.equal(holder.length, scc.comps[ci].length,
        `the component id sends ${v} to is not the one that holds it — ${where(g)}`);
    }
    if (scc.comps.some(c => c.length > 1)) withMulti++;
  }
  assert.ok(withMulti > 30, `the table must produce multi-node components or every component is trivially size 1 (got ${withMulti})`);
});

test('two nodes share a component IFF each reaches the other — brute-force oracle over seeded random digraphs', () => {
  assert.ok(GRAPHS.length > 0, 'an empty table satisfies every assertion in the loop below without running one');
  let merged = 0, split = 0;
  for (const g of GRAPHS) {
    const { nodes, adj } = digraph(g.n, g.density, g.seed);
    const scc = tarjan(nodes, adj);
    const reach = closure(nodes, adj);
    for (const a of nodes) {
      for (const b of nodes) {
        if (a === b) continue;
        const mutual = reach.get(a).has(b) && reach.get(b).has(a);
        const together = scc.id.get(a) === scc.id.get(b);
        assert.equal(together, mutual,
          `${a},${b}: same component ${together}, mutually reachable ${mutual} — ${where(g)}`);
        if (mutual) merged++; else split++;
      }
    }
  }
  assert.ok(merged > 0, 'no mutually reachable pair in the whole table — only the split half of the IFF was measured');
  assert.ok(split > 0, 'no separated pair in the whole table — only the merged half of the IFF was measured');
});

test('a component is emitted only after everything it reaches: a cross-component edge points at a LOWER index', () => {
  assert.ok(GRAPHS.length > 0, 'an empty table satisfies every assertion in the loop below without running one');
  let crossEdges = 0;
  for (const g of GRAPHS) {
    const { nodes, adj } = digraph(g.n, g.density, g.seed);
    const scc = tarjan(nodes, adj);
    for (const a of nodes) {
      for (const b of adj.get(a)) {
        const ca = scc.id.get(a), cb = scc.id.get(b);
        if (ca === cb) continue;
        crossEdges++;
        assert.ok(cb < ca,
          `${a}->${b} crosses ${ca}->${cb}: the target component must already be emitted, and render.mjs's cycComps filters comps in this order straight into the stdout JSON's sccs arrays and the report's cycle lines — ${where(g)}`);
      }
    }
  }
  assert.ok(crossEdges > 0, 'no cross-component edge in the whole table — the ordering claim was never exercised');
});

test('the same input twice yields identical comps and ids', () => {
  // component ids depend on input order BY DESIGN, so this pins repeatability on
  // one input, never invariance under a permutation of it
  const { nodes, adj } = digraph(21, 0.08, 4242);
  const first = tarjan(nodes, adj);
  const second = tarjan(nodes, adj);
  assert.ok(first.comps.length > 1 && first.comps.some(c => c.length > 1),
    'an all-singleton or single-blob graph compares equal under any ordering bug');
  assert.deepEqual(second.comps, first.comps);
  assert.deepEqual([...second.id], [...first.id]);
});

test('a 100000-node chain completes: the explicit work stack is what keeps this off the call stack', () => {
  const N = 100000;
  const nodes = Array.from({ length: N }, (_, i) => `c${i}`);
  const adj = new Map(nodes.map((v, i) => [v, i + 1 < N ? [`c${i + 1}`] : []]));
  const scc = tarjan(nodes, adj);
  assert.equal(scc.comps.length, N, 'a chain carries no cycle: every node is its own component');
  assert.equal(scc.id.get(`c${N - 1}`), 0, 'the tail reaches nothing, so it is emitted first');
  assert.equal(scc.id.get('c0'), N - 1, 'the head reaches everything, so it is emitted last');
});

test('a self-loop is a size-1 component, so the cycle filter does not count it; an isolated node is one too', () => {
  const nodes = ['iso', 'self', 'a', 'b'];
  const adj = new Map([['iso', []], ['self', ['self']], ['a', ['b']], ['b', ['a']]]);
  const scc = tarjan(nodes, adj);
  const sizeOf = (n) => scc.comps[scc.id.get(n)].length;
  assert.equal(sizeOf('iso'), 1);
  assert.equal(sizeOf('self'), 1, 'one node, even though it reaches itself');
  assert.equal(sizeOf('a'), 2);
  const cycles = scc.comps.filter(c => c.length > 1);
  assert.equal(cycles.length, 1,
    'render.mjs and the JSON summary both define a cycle as comps.length > 1, so a file importing itself is reported acyclic — this pins that fact, not an intent');
  assert.deepEqual([...cycles[0]].sort(), ['a', 'b']);
});

const rawOf = (entries) => ({
  ...EMPTY_RAW,
  files: entries.map(e => e.file),
  fileCtx: Object.fromEntries(entries.map(e => [e.file, e.ctx])),
  fileNs: Object.fromEntries(entries.map(e => [e.file, e.ctx + NS_SEP + e.ns])),
});

test('a colour is keyed on the SORTED name, so the order files arrive in cannot move it', () => {
  const entries = [
    { file: 'zeta/src/z.ts', ctx: 'zeta', ns: 'z' },
    { file: 'alpha/src/a.ts', ctx: 'alpha', ns: 'a' },
    { file: 'mu/src/m.ts', ctx: 'mu', ns: 'm' },
  ];
  const forward = assemble(rawOf(entries));
  const reversed = assemble(rawOf([...entries].reverse()));
  assert.equal(Object.keys(forward.ctxColourMap).length, 3, 'without contexts the two maps compare empty to empty');
  assert.deepEqual(forward.contextOrder, ['alpha', 'mu', 'zeta'], 'sorted, not first-seen — arrival order here puts zeta first');
  assert.deepEqual(reversed.ctxColourMap, forward.ctxColourMap,
    'readdir order is not stable, so a colour keyed on arrival repaints the artifact run to run');
  assert.deepEqual(reversed.nsColourMap, forward.nsColourMap, 'same claim, one level down');
  assert.equal(new Set(Object.values(forward.ctxColourMap)).size, 3, 'three contexts inside an 8-slot palette must not collide');
  // order-invariance alone does not make the SORTED POSITION the key: an index
  // reflected end to end, or the other level's palette, is invariant too
  assert.deepEqual(forward.ctxColourMap, { alpha: CTX_PALETTE[0], mu: CTX_PALETTE[1], zeta: CTX_PALETTE[2] },
    'sorted position IS the CTX_PALETTE index, counting forward from 0');
  assert.deepEqual(forward.nsColourMap, {
    [`alpha${NS_SEP}a`]: NS_PALETTE[0], [`mu${NS_SEP}m`]: NS_PALETTE[1], [`zeta${NS_SEP}z`]: NS_PALETTE[2],
  }, 'and one level down the index runs into the OTHER palette — the two levels must not share an array');
});

test('the two palettes wrap at their own lengths — 8 for contexts, 16 for namespaces', () => {
  const entries = Array.from({ length: 20 }, (_, i) => {
    const k = String(i).padStart(2, '0');
    return { file: `c${k}/src/f.ts`, ctx: `c${k}`, ns: `n${k}` };
  });
  const m = assemble(rawOf(entries));
  const sortedCtx = entries.map(e => e.ctx);
  const sortedNs = entries.map(e => `${e.ctx}${NS_SEP}${e.ns}`);
  assert.equal(sortedCtx.length, 20, 'the two vectors below are compared element-wise, and two empty ones compare equal');
  assert.equal(sortedNs.length, 20, 'same premise one level down');
  assert.deepEqual(sortedCtx, [...sortedCtx].sort(), 'c00..c19 is already the sorted order, which is what the index below indexes');
  assert.deepEqual(sortedNs, [...sortedNs].sort(), 'and the ns keys sort the same way, ctx-major');
  const ctxColours = Object.values(m.ctxColourMap);
  const nsColours = Object.values(m.nsColourMap);
  assert.equal(ctxColours.length, 20, 'twenty contexts must reach the map or the counts below are read off nothing');
  assert.equal(nsColours.length, 20);
  assert.equal(new Set(ctxColours).size, 8, 'twenty contexts over the context palette reuse exactly its 8 entries');
  assert.equal(new Set(nsColours).size, 16, 'the namespace palette is the longer one; reusing the context palette would collapse this to 8');
  assert.equal(m.ctxColour('c08'), m.ctxColour('c00'), 'index 8 wraps onto 0');
  assert.equal(m.ctxColour('c16'), m.ctxColour('c00'), 'and so does 16');
  assert.notEqual(m.ctxColour('c01'), m.ctxColour('c00'), 'adjacent indices inside one lap stay apart');
  assert.equal(m.colourOf(`c16${NS_SEP}n16`), m.colourOf(`c00${NS_SEP}n00`), 'index 16 wraps onto 0');
  assert.notEqual(m.colourOf(`c08${NS_SEP}n08`), m.colourOf(`c00${NS_SEP}n00`), 'index 8 is still inside the first namespace lap');
  // the counts above see a MODULUS and nothing else: painting contexts out of
  // NS_PALETTE keeps all 8/16 counts intact, and so does an index reflected end
  // to end. Compared against the exported palettes, so recolouring stays free
  // while the wiring does not.
  assert.deepEqual(sortedCtx.map(n => m.ctxColour(n)), sortedCtx.map((_, i) => CTX_PALETTE[i % CTX_PALETTE.length]),
    'the i-th sorted context takes CTX_PALETTE[i % 8] — which palette, and which direction the index runs');
  assert.deepEqual(sortedNs.map(n => m.colourOf(n)), sortedNs.map((_, i) => NS_PALETTE[i % NS_PALETTE.length]),
    'the i-th sorted namespace takes NS_PALETTE[i % 16] — the levels must not cross-wire in either direction');
  // the premise the two deepEquals above rest on: comparing model output
  // against the exported palettes catches a cross-wire only while the palettes
  // are distinguishable at the compared indices. This is the one constraint
  // recolouring must respect.
  assert.equal(CTX_PALETTE.filter(c => NS_PALETTE.includes(c)).length, 0,
    'the palettes must share no entry, or a cross-wire moves both sides of the deepEquals and is invisible');
  for (const c of [...ctxColours, ...nsColours]) {
    assert.match(c, /^#[0-9a-f]{6}$/, `every entry is written straight into a CSS background, got ${c}`);
    // literal on purpose: this is the one claim the exported palettes cannot
    // carry, since a white entry would move both sides of the deepEquals above
    assert.notEqual(c, '#ffffff', `#ffffff is the unknown-name fallback, so no palette entry may be it — got ${c}`);
  }
});

test("an unknown name falls back to '#ffffff' rather than undefined in the style attribute", () => {
  const m = assemble(rawOf([{ file: 'app/src/a.ts', ctx: 'app', ns: 'core' }]));
  // ctxColour IS `ctxColourMap[n] ?? '#ffffff'`, so comparing the two is one
  // expression against itself; the value is what a hit can be measured by
  assert.equal(m.ctxColour('app'), CTX_PALETTE[0], 'the only context sorts first, so a hit reads CTX_PALETTE[0]');
  assert.notEqual(m.ctxColour('app'), '#ffffff', 'no palette entry may be white, or the fallback below is indistinguishable from a hit');
  assert.notEqual(m.colourOf(`app${NS_SEP}core`), '#ffffff');
  assert.equal(m.ctxColour('never-analysed'), '#ffffff');
  assert.equal(m.colourOf(`never${NS_SEP}analysed`), '#ffffff');
});

test('distinctInOrder keeps first-seen order over a seeded sequence full of duplicates', () => {
  const rand = lcg(90210);
  const alphabet = ['e', 'a', 'd', 'b', 'f', 'c'];
  const seq = Array.from({ length: 200 }, () => alphabet[Math.floor(rand() * alphabet.length)]);
  const out = distinctInOrder(seq);
  assert.ok(out.length > 1, 'a one-symbol draw satisfies the equality below trivially');
  assert.ok(out.length < seq.length, 'the sequence must actually repeat or the dedupe is never exercised');
  assert.deepEqual(out, [...new Set(seq)], 'Set insertion order IS first-seen order, so it is the oracle');
  assert.notDeepEqual(out, [...out].sort(), 'the draw must not arrive sorted, or first-seen and sorted are the same answer');
});
