// Shared finalize step + Tarjan SCC + ordered-set helpers.
// Port of Core/ModelBuilder.cs + Core/Scc.cs.
//
// Input shape (from any analyzer, possibly merged):
//   { files: string[], fileCtx: {file:ctx}, fileNs: {file:ns},
//     edges: [from,to][], tpEdges: [from,pkg][], tpPkgs: string[],
//     typeXctxEdges: [from,to][], skips: [{stage,subject,reason}] }
// Output: a finalized Model with palette colours, per-level Tarjan SCCs,
// cluster lists, ns→files map — directly consumed by render.mjs.

export const NS_SEP = ' · ';

// exported so a gate can assert WHICH palette feeds which level and that the
// index runs forward — a test carrying its own hex literals pins neither
export const CTX_PALETTE = [
  '#eaf2ff', '#fdeef0', '#ecfbef', '#fff5d6', '#f3e8ff', '#e6fbfb', '#fef3e2', '#eef2f7'
];
export const NS_PALETTE = [
  '#cfe8ff', '#ffd1dc', '#d6f5d6', '#ffe9a6', '#e6c9e0', '#cfe8e0', '#ffdfba', '#d9d9d9',
  '#ffc9c9', '#cce5ff', '#ffe0b3', '#ffb3ba', '#c9e4ff', '#d6d6f5', '#f5d6d6', '#d6f5ec'
];

// The one comparator every ordering in this tool routes through. localeCompare
// depends on the host ICU build AND on the default locale, so identical input
// on two machines emits different bytes; every order here reaches the artifact
// or the stdout JSON, and is therefore data.
export const ord = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Skip list normalizer: dedupe on the (stage,subject,reason) triple, then
// ordinal sort by it. readdir order is not stable, so an unsorted list would
// diff dirtily across runs with identical content.
export function sortSkips(list) {
  const seen = new Set(), out = [];
  for (const s of list ?? []) {
    const k = s.stage + '\0' + s.subject + '\0' + s.reason;
    if (!seen.has(k)) { seen.add(k); out.push(s); }
  }
  return out.sort((a, b) => ord(a.stage, b.stage) || ord(a.subject, b.subject) || ord(a.reason, b.reason));
}

// Stage tally for the skip list, ranked desc by count then ordinal by stage —
// the ONE digest shape the fatal message, the stderr report and the JSON summary
// all render. Lives here rather than in render.mjs because index.mjs digests raw
// skips before a Model exists.
export function byStage(skips) {
  const m = new Map();
  for (const s of skips) m.set(s.stage, (m.get(s.stage) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || ord(a[0], b[0])).map(([stage, count]) => ({ stage, count }));
}
export const skipDigest = (skips) => byStage(skips).map(x => `${x.stage} ${x.count}`).join(', ');

// Distinct preserving first-seen order (≡ [...new Set(seq)]).
export function distinctInOrder(seq) {
  const s = new Set(), o = [];
  for (const x of seq) if (!s.has(x)) { s.add(x); o.push(x); }
  return o;
}

// Tarjan SCC; node + neighbour order preserved → deterministic component ids.
// Iterative (avoid recursion-depth blowups on large graphs).
export function tarjan(nodes, adj) {
  const comps = [];
  const id = new Map();
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  let idx = 0;

  // explicit work stack: each frame = { v, neighbours, ni }
  for (const start of nodes) {
    if (index.has(start)) continue;
    const work = [];
    const push = (v) => {
      index.set(v, idx); low.set(v, idx); idx++;
      stack.push(v); onStack.add(v);
      work.push({ v, ns: adj.get(v) || [], ni: 0 });
    };
    push(start);
    while (work.length > 0) {
      const f = work[work.length - 1];
      if (f.ni < f.ns.length) {
        const w = f.ns[f.ni++];
        if (!index.has(w)) { push(w); continue; }
        if (onStack.has(w)) low.set(f.v, Math.min(low.get(f.v), index.get(w)));
        continue;
      }
      // post-visit
      if (low.get(f.v) === index.get(f.v)) {
        const comp = [];
        let w;
        do {
          w = stack.pop(); onStack.delete(w); comp.push(w);
        } while (w !== f.v);
        const ci = comps.length;
        comps.push(comp);
        for (const n of comp) id.set(n, ci);
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1];
        low.set(parent.v, Math.min(low.get(parent.v), low.get(f.v)));
      }
    }
  }
  return { comps, id, size: (n) => comps[id.get(n)].length };
}

function buildClusterAdj(clusters, edges, of) {
  const sets = new Map();
  const adj = new Map();
  for (const g of clusters) { sets.set(g, new Set()); adj.set(g, []); }
  for (const [a, b] of edges) {
    const ga = of(a), gb = of(b);
    if (ga !== gb) {
      const set = sets.get(ga);
      if (set && !set.has(gb)) { set.add(gb); adj.get(ga).push(gb); }
    }
  }
  return adj;
}

export function assemble(raw) {
  const { files, fileCtx, fileNs, edges, tpEdges, tpPkgs, typeXctxEdges } = raw;
  const skips = sortSkips(Array.isArray(raw.skips) ? raw.skips : []);
  const ctxOf = (f) => fileCtx[f] ?? 'other';
  const grpOf = (f) => fileNs[f] ?? 'other';

  // palette colour by sorted name → deterministic
  const usedCtx = [...new Set(files.map(ctxOf))].sort();
  const usedNs = [...new Set(files.map(grpOf))].sort();
  const ctxColourMap = {};
  for (let i = 0; i < usedCtx.length; i++) ctxColourMap[usedCtx[i]] = CTX_PALETTE[i % CTX_PALETTE.length];
  const nsColourMap = {};
  for (let i = 0; i < usedNs.length; i++) nsColourMap[usedNs[i]] = NS_PALETTE[i % NS_PALETTE.length];

  // file-level SCC
  const fAdj = new Map();
  for (const f of files) fAdj.set(f, []);
  for (const [a, b] of edges) fAdj.get(a)?.push(b);
  const fileScc = tarjan(files, fAdj);

  // namespace-level SCC
  const allGroups = distinctInOrder(files.map(grpOf));
  const gAdj = buildClusterAdj(allGroups, edges, grpOf);
  const groupScc = tarjan(allGroups, gAdj);

  // context-level SCC
  const allCtx = distinctInOrder(files.map(ctxOf));
  const cAdj = buildClusterAdj(allCtx, edges, ctxOf);
  const ctxScc = tarjan(allCtx, cAdj);

  // ns → file list (insertion order)
  const byGroup = {};
  for (const f of files) {
    const g = grpOf(f);
    (byGroup[g] ??= []).push(f);
  }

  return {
    files,
    edges,
    fileScc, groupScc, ctxScc,
    allGroups, allCtx,
    byGroup,
    fileCtx, fileNs,
    ctxColourMap, nsColourMap,
    contextOrder: usedCtx,
    tpPackages: [...new Set(tpPkgs)].sort(),
    tpEdges,
    typeXctxEdges,
    skips,
    ctxOf, grpOf,
    ctxColour: (n) => ctxColourMap[n] ?? '#ffffff',
    colourOf: (g) => nsColourMap[g] ?? '#ffffff',
  };
}
