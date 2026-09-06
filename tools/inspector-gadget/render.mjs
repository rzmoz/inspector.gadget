// Render a finalized Model → codebase-dsm.html (matrix-only) + compact JSON
// summary on stdout. Port of Core/Viewer.cs minus everything graph-related.
//
// WIRE CONTRACT with assets/dsm.client.js (no compile-time link — change both
// sides together): node ids "c:"/"n:"/"f:"; ns labels "{ctx}{NS_SEP}{name}";
// payload.edges = [fromFileIdx,toFileIdx]; payload keys = wireKey() below.
//
// Skips ride the MODEL, never the payload: dsm.client.js rewrites #meta.innerHTML
// on every render, so a payload-borne banner is erased on first interaction.
// ${SKIPS} is a static template fill outside #meta, and the client is untouched.

import fs from 'node:fs';
import path from 'node:path';
import { NS_SEP } from './model.mjs';

const wire = {
  ctxId: (ctx) => 'c:' + ctx,
  nsId:  (ns)  => 'n:' + ns,
  fileId: (i)  => 'f:' + i,
};
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fileLabel = (f) => { const p = f.split('/'); return p.length <= 2 ? f : p.slice(-2).join('/'); };
const nsLeaf = (ns) => { const p = ns.split(NS_SEP); return p[p.length - 1]; };

// dependency-first ("triangular") sibling order for one level
function triOrder(nodes, nodeOf, scc, labelFor, ctxFor, edges) {
  const N = nodes.length;
  const pos = new Map();
  for (let i = 0; i < N; i++) pos.set(nodes[i], i);
  const label = new Array(N), ctx = new Array(N);
  for (let i = 0; i < N; i++) { label[i] = labelFor(nodes[i]); ctx[i] = ctxFor(nodes[i]); }

  // per-node adjacency, insertion order preserved
  const adj = Array.from({ length: N }, () => ({ set: new Set(), items: [] }));
  for (const [a, b] of edges) {
    const i = pos.get(nodeOf(a)); if (i === undefined) continue;
    const j = pos.get(nodeOf(b)); if (j === undefined) continue;
    if (i === j) continue;
    const s = adj[i]; if (!s.set.has(j)) { s.set.add(j); s.items.push(j); }
  }

  const compOf = (i) => scc.id.get(nodes[i]);
  const ncomp = scc.comps.length;
  const cadj = Array.from({ length: ncomp }, () => ({ set: new Set(), items: [] }));
  for (let i = 0; i < N; i++)
    for (const j of adj[i].items) {
      const a = compOf(i), b = compOf(j);
      if (a !== b && !cadj[a].set.has(b)) { cadj[a].set.add(b); cadj[a].items.push(b); }
    }

  const compMin = new Array(ncomp).fill(null);
  for (let i = 0; i < N; i++) {
    const c = compOf(i);
    if (compMin[c] === null || label[i] < compMin[c]) compMin[c] = label[i];
  }

  // localeCompare mirror — matches dsm.client.js's alpha sort
  const lc = (a, b) => (compMin[a] ?? '').localeCompare(compMin[b] ?? '');

  const visited = new Set();
  const post = [];
  function dfs(c) {
    visited.add(c);
    for (const d of [...cadj[c].items].sort(lc)) if (!visited.has(d)) dfs(d);
    post.push(c);
  }
  for (const c of [...Array(ncomp).keys()].sort(lc)) if (!visited.has(c)) dfs(c);

  const members = Array.from({ length: ncomp }, () => []);
  for (let i = 0; i < N; i++) members[compOf(i)].push(i);
  const labelLc = (a, b) => label[a].localeCompare(label[b]);
  for (let c = 0; c < ncomp; c++) members[c].sort(labelLc);

  const triGlobal = [];
  for (const c of post) for (const m of members[c]) triGlobal.push(m);

  return contextMajorOrder(triGlobal, ctx, adj, N);
}

// context-major partition: each context stays one contiguous dep-first run
function contextMajorOrder(triGlobal, ctx, adj, N) {
  const ctxKeys = [];
  const seen = new Set();
  for (const c of ctx) if (!seen.has(c)) { seen.add(c); ctxKeys.push(c); }
  const ctxAdj = new Map();
  for (const c of ctxKeys) ctxAdj.set(c, { set: new Set(), items: [] });
  for (let i = 0; i < N; i++) for (const j of adj[i].items) {
    if (ctx[i] !== ctx[j]) {
      const s = ctxAdj.get(ctx[i]);
      if (!s.set.has(ctx[j])) { s.set.add(ctx[j]); s.items.push(ctx[j]); }
    }
  }
  const cvis = new Set();
  const cpost = [];
  function cdfs(c) {
    cvis.add(c);
    for (const d of [...ctxAdj.get(c).items].sort()) if (!cvis.has(d)) cdfs(d);
    cpost.push(c);
  }
  for (const c of [...ctxKeys].sort()) if (!cvis.has(c)) cdfs(c);

  const order = [];
  for (const c of cpost) for (const i of triGlobal) if (ctx[i] === c) order.push(i);
  return order;
}

// first-party context→namespace→file tree
function buildTree(model, ctxOrder, nsByCtx, filesByNs, fIndex) {
  const nodes = {};
  const roots = [];
  for (const c of ctxOrder) {
    const cid = wire.ctxId(c);
    const ctxNode = { id: cid, kind: 'context', label: c, title: c, colour: model.ctxColour(c), ctx: c, parent: null, children: [], depth: 0 };
    nodes[cid] = ctxNode; roots.push(cid);
    for (const ns of nsByCtx[c]) {
      const nid = wire.nsId(ns);
      const nsNode = { id: nid, kind: 'namespace', label: ns, title: ns, colour: model.colourOf(ns), ctx: c, parent: cid, children: [], depth: 1 };
      nodes[nid] = nsNode; ctxNode.children.push(nid);
      for (const f of filesByNs[ns]) {
        const fi = fIndex.get(f);
        const fid = wire.fileId(fi);
        nodes[fid] = { id: fid, kind: 'file', label: fileLabel(f), title: f, colour: model.colourOf(ns), ctx: c, parent: nid, children: [], depth: 2, fi };
        nsNode.children.push(fid);
      }
    }
  }
  return { nodes, roots };
}

// matrix data: file-indexed edges, per-file SCC comp, cycles, reachability pairs
function buildMatrixData(model, fIndex) {
  const edgeIdx = model.edges.map(([a, b]) => [fIndex.get(a), fIndex.get(b)]);
  const fileComp = model.files.map(f => model.fileScc.id.get(f));
  const cycleComps = model.fileScc.comps.map((c, i) => [i, c.length]).filter(x => x[1] > 1).map(x => x[0]);

  // transitive reachability per file → indirect-mode cells
  const n = model.files.length;
  const fadj = Array.from({ length: n }, () => []);
  for (const [a, b] of edgeIdx) fadj[a].push(b);
  const reachPairs = [];
  for (let i = 0; i < n; i++) {
    const seenSet = new Set();
    const seenOrder = [];
    const st = [...fadj[i]];
    while (st.length > 0) {
      const x = st.pop();
      if (seenSet.has(x)) continue;
      seenSet.add(x);
      seenOrder.push(x);
      for (const y of fadj[x]) if (!seenSet.has(y)) st.push(y);
    }
    for (const j of seenOrder) if (j !== i) reachPairs.push([i, j]);
  }
  return { edgeIdx, fileComp, cycleComps, reachPairs };
}

// third-party refs as synthetic sink "files"; mutates nodes/roots/contexts
function buildThirdParty(model, nodes, roots, contexts, fIndex) {
  const tpCtx = '(third-party)', tpCtxColour = '#e9d5ff', tpNodeColour = '#d8b4fe';
  const packages = model.tpPackages;
  const tpFi = new Map();
  for (let i = 0; i < packages.length; i++) tpFi.set(packages[i], model.files.length + i);
  const tpCtxId = wire.ctxId(tpCtx);
  if (packages.length > 0) {
    const tpCtxNode = { id: tpCtxId, kind: 'context', label: tpCtx, title: tpCtx + ' — external references', colour: tpCtxColour, ctx: tpCtx, parent: null, children: [], depth: 0, tp: true };
    nodes[tpCtxId] = tpCtxNode; roots.push(tpCtxId);
    for (const pkg of packages) {
      const nid = wire.nsId(pkg), fi = tpFi.get(pkg), fid = wire.fileId(fi);
      const nsNode = { id: nid, kind: 'namespace', label: pkg, title: pkg, colour: tpNodeColour, ctx: tpCtx, parent: tpCtxId, children: [fid], depth: 1, tp: true };
      nodes[nid] = nsNode; tpCtxNode.children.push(nid);
      nodes[fid] = { id: fid, kind: 'file', label: pkg, title: pkg, colour: tpNodeColour, ctx: tpCtx, parent: nid, children: [], depth: 2, fi, tp: true };
    }
    contexts.push({ name: tpCtx, colour: tpCtxColour });
  }
  const tpEdgeIdx = model.tpEdges.map(([from, pkg]) => [fIndex.get(from), tpFi.get(pkg)]);
  return { tpCtxId: packages.length > 0 ? tpCtxId : null, tpEdgeIdx };
}

function buildPayload(model) {
  const files = model.files;
  const fIndex = new Map();
  for (let i = 0; i < files.length; i++) fIndex.set(files[i], i);

  const ctxOrderIdx = triOrder(model.allCtx, model.ctxOf, model.ctxScc, n => n, n => n, model.edges);
  const nsOrderIdx = triOrder(model.allGroups, model.grpOf, model.groupScc, n => n,
    g => model.ctxOf(model.byGroup[g][0]), model.edges);
  const fileOrderIdx = triOrder(files, f => f, model.fileScc, fileLabel, model.ctxOf, model.edges);

  const ctxOrder = ctxOrderIdx.map(i => model.allCtx[i]);
  const nsOrderAll = nsOrderIdx.map(i => model.allGroups[i]);
  const fileOrderAll = fileOrderIdx.map(i => files[i]);

  const nsByCtx = Object.fromEntries(ctxOrder.map(c => [c, []]));
  for (const ns of nsOrderAll) nsByCtx[model.ctxOf(model.byGroup[ns][0])].push(ns);
  const filesByNs = Object.fromEntries(nsOrderAll.map(ns => [ns, []]));
  for (const f of fileOrderAll) filesByNs[model.grpOf(f)].push(f);

  const { nodes, roots } = buildTree(model, ctxOrder, nsByCtx, filesByNs, fIndex);
  const { edgeIdx, fileComp, cycleComps, reachPairs } = buildMatrixData(model, fIndex);

  const contexts = model.contextOrder
    .filter(n => model.allCtx.includes(n))
    .map(n => ({ name: n, colour: model.ctxColour(n) }));

  const { tpCtxId, tpEdgeIdx } = buildThirdParty(model, nodes, roots, contexts, fIndex);

  return {
    nodes, roots,
    edges: [...edgeIdx, ...tpEdgeIdx],
    filePaths: [...files, ...model.tpPackages],
    fileComp, cycleComps, reachPairs,
    contexts,
    thirdPartyCtxId: tpCtxId,
    fileCount: files.length,
    edgeCount: model.edges.length,
    // matrix-only build: no graph payload (graph tab removed)
    _meta: { ctxOrder, nsOrderAll, fileOrderAll, nsByCtx, filesByNs }, // for summary
  };
}

// single-pass: inserted values contain their own `${...}`, so never re-scan them.
// The scan is over the TEMPLATE only — ${CLIENT} inlines a JS file full of
// template literals, so scanning the OUTPUT would fire on every run.
// An unknown token in the template, or a value nothing consumes, is a template/
// renderer mismatch and throws rather than shipping a ${...} into the artifact.
function fill(tpl, vals) {
  let out = '', i = 0;
  const used = new Set();
  while (i < tpl.length) {
    const p = tpl.indexOf('${', i);
    if (p < 0) { out += tpl.slice(i); break; }
    out += tpl.slice(i, p);
    const e = tpl.indexOf('}', p + 2);
    if (e < 0) { out += tpl.slice(p); break; }
    const tok = tpl.slice(p, e + 1);
    if (!Object.prototype.hasOwnProperty.call(vals, tok)) {
      throw new Error(`template.html carries an unknown placeholder ${tok} — render.mjs supplies none`);
    }
    used.add(tok);
    out += vals[tok];
    i = e + 1;
  }
  const unused = Object.keys(vals).filter(k => !used.has(k));
  if (unused.length > 0) {
    throw new Error(`render.mjs supplies ${unused.join(', ')} and template.html consumes none of them`);
  }
  return out;
}

// The artifact outlives the run and gets opened a week later with no stderr
// anywhere, so it carries the COMPLETE list, not a sample.
function skipsHtml(skips) {
  if (skips.length === 0) return '<div class="skips ok">skipped: none</div>';
  const rows = skips.map(s =>
    `<tr><td>${escHtml(s.stage)}</td><td>${escHtml(s.subject)}</td><td>${escHtml(s.reason)}</td></tr>`).join('');
  return `<details class="skips bad"><summary>PARTIAL READ — ${skips.length} subject(s) skipped</summary>`
    + `<table><thead><tr><th>stage</th><th>subject</th><th>reason</th></tr></thead><tbody>${rows}</tbody></table></details>`;
}

// stage counts, desc by count then ordinal by stage — the one digest shape all
// three surfaces render.
function byStage(skips) {
  const m = new Map();
  for (const s of skips) m.set(s.stage, (m.get(s.stage) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([stage, count]) => ({ stage, count }));
}

function assembleHtml(title, payload, assetsDir, skips) {
  const css = fs.readFileSync(path.join(assetsDir, 'template.css'), 'utf8');
  const template = fs.readFileSync(path.join(assetsDir, 'template.html'), 'utf8');
  const client = fs.readFileSync(path.join(assetsDir, 'dsm.client.js'), 'utf8');
  // strip the summary helper from the wire payload (internal only)
  const { _meta, ...wirePayload } = payload;
  const json = JSON.stringify(wirePayload);
  return fill(template, {
    '${title}': title,
    '${CSS}': css,
    '${JSON.stringify(payload)}': json,
    '${CLIENT}': client,
    '${SKIPS}': skipsHtml(skips),
  });
}

// per-ctx / per-ns degree + asymmetries + 3p consumer counts
function buildSummary(model, payload, title, outPath, htmlLen) {
  const { ctxOrder, nsOrderAll, nsByCtx } = payload._meta;
  const ctxOf = model.ctxOf, grpOf = model.grpOf;

  const ctxStats = new Map();
  for (const c of ctxOrder) ctxStats.set(c, { in: 0, out: 0, internal: 0, files: 0, ns: nsByCtx[c].length });
  for (const f of model.files) ctxStats.get(ctxOf(f)).files++;
  const nsStats = new Map();
  for (const ns of nsOrderAll) nsStats.set(ns, { in: 0, out: 0, internal: 0, files: model.byGroup[ns].length, ctx: ctxOf(model.byGroup[ns][0]) });

  const ctxPair = new Map(); // "a>b" → count
  for (const [a, b] of model.edges) {
    const ca = ctxOf(a), cb = ctxOf(b);
    const na = grpOf(a), nb = grpOf(b);
    if (ca === cb) ctxStats.get(ca).internal++;
    else { ctxStats.get(ca).out++; ctxStats.get(cb).in++;
      const k = ca + '>' + cb; ctxPair.set(k, (ctxPair.get(k) ?? 0) + 1); }
    if (na === nb) nsStats.get(na).internal++;
    else { nsStats.get(na).out++; nsStats.get(nb).in++; }
  }

  // asymmetries: A→B with B→A absent
  const asym = [];
  for (const [k, count] of ctxPair) {
    const [a, b] = k.split('>');
    if (!ctxPair.has(b + '>' + a)) asym.push({ from: a, to: b, count });
  }
  asym.sort((x, y) => y.count - x.count || x.from.localeCompare(y.from));

  // 3p consumer counts (per package, distinct first-party namespaces)
  const tpConsumers = new Map();
  for (const [from, pkg] of model.tpEdges) {
    if (!tpConsumers.has(pkg)) tpConsumers.set(pkg, new Set());
    tpConsumers.get(pkg).add(grpOf(from));
  }
  const tp = [...tpConsumers].map(([pkg, set]) => ({ package: pkg, consumers: set.size }))
    .sort((a, b) => b.consumers - a.consumers || a.package.localeCompare(b.package));

  const cycComps = (scc) => scc.comps.filter(c => c.length > 1);
  const fileCycles = cycComps(model.fileScc);
  const nsCycles = cycComps(model.groupScc);
  const ctxCycles = cycComps(model.ctxScc);

  return {
    title,
    output: outPath,
    htmlSizeKB: Math.round(htmlLen / 1024),
    totals: {
      files: model.files.length,
      edges: model.edges.length,
      namespaces: model.allGroups.length,
      contexts: model.allCtx.length,
      thirdParty: model.tpPackages.length,
      fileCycles: fileCycles.length,
      nsCycles: nsCycles.length,
      ctxCycles: ctxCycles.length,
    },
    contexts: ctxOrder.map(c => ({ name: c, colour: model.ctxColour(c), ...ctxStats.get(c) })),
    namespaces: nsOrderAll.map(ns => ({ name: ns, leaf: nsLeaf(ns), ...nsStats.get(ns) })),
    sccs: {
      context: ctxCycles.map(c => [...c]),
      namespace: nsCycles.map(c => [...c]),
    },
    crossCtxAsymmetries: asym,
    thirdParty: tp,
    skipped: {
      total: model.skips.length,
      byStage: byStage(model.skips),
      sample: model.skips.slice(0, 20),
      omitted: Math.max(0, model.skips.length - 20),
    },
  };
}

// stderr: human-readable report; stdout: compact JSON summary.
function printHumanReport(model, outPath, htmlLen) {
  const out = (s) => process.stderr.write(s + '\n');
  out(`files: ${model.files.length} | edges: ${model.edges.length} | namespaces: ${model.allGroups.length} | contexts: ${model.allCtx.length}`);
  if (model.skips.length === 0) out('skipped: none');
  else {
    const digest = byStage(model.skips).map(x => `${x.stage} ${x.count}`).join(', ');
    out(`skipped: ${model.skips.length} subject(s) (${digest}) — PARTIAL READ`);
    for (const s of model.skips.slice(0, 20)) out(`  • ${s.stage}  ${s.subject}  [${s.reason}]`);
    if (model.skips.length > 20) out(`  … and ${model.skips.length - 20} more (full list in the HTML)`);
  }
  const c = (scc) => scc.comps.filter(x => x.length > 1);
  const ctxCycles = c(model.ctxScc), nsCycles = c(model.groupScc), fileCycles = c(model.fileScc);
  out(`\ncontext-level: ${ctxCycles.length > 0 ? 'CYCLE(S) — architecture violation!' : 'acyclic ✓'}`);
  for (const x of ctxCycles) out('  ' + x.join(' <-> '));
  out(`\nnamespace cycles: ${nsCycles.length > 0 ? nsCycles.length : 'none ✓'}`);
  for (const x of nsCycles) out('  • ' + x.join('  <->  '));
  out(`\nfile import cycles: ${fileCycles.length > 0 ? fileCycles.length : 'none ✓'}`);
  for (const x of fileCycles) out('  • ' + x.join('  <->  '));
  const kb = Math.round(htmlLen / 1024);
  out(`\nwrote: ${outPath} (${kb} KB)  — matrix DSM (open in a browser)`);
}

export function render(model, { root, title, outputDsm, assetsDir }) {
  const payload = buildPayload(model);
  const html = assembleHtml(title, payload, assetsDir, model.skips);
  fs.writeFileSync(outputDsm, html, 'utf8');
  printHumanReport(model, outputDsm, html.length);
  const summary = buildSummary(model, payload, title, outputDsm, html.length);
  process.stdout.write(JSON.stringify(summary) + '\n');
  return summary;
}
