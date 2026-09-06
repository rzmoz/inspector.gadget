// mergeRaw beyond the three cases failure-channel already covers.
//
// The merge path is exercised only by a mixed repo — the configuration nobody
// runs by accident — and its failure mode is silent: two analyzers naming one
// leaf overwrote each other's context and namespace and double-counted the row
// in every per-file tally, with nothing on any of the three surfaces.
//
// The two-part branch also had no end-to-end coverage: every other case in the
// suite runs a single analyzer, so the code that concatenates two raw shapes was
// only ever reached through hand-built parts. A target carrying both ecosystems
// is the one configuration that drives it through the real CLI.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { withFixture, run, payloadOf, htmlPath, REPO, TWO_CONTEXTS } from './helpers/fixture.mjs';
import { detect, mergeRaw } from '../tools/inspector-gadget/index.mjs';
import * as analyzeTs from '../tools/inspector-gadget/analyze-ts.mjs';
import { NS_SEP } from '../tools/inspector-gadget/model.mjs';

const EMPTY = { files: [], fileCtx: {}, fileNs: {}, edges: [], tpEdges: [], tpPkgs: [], typeXctxEdges: [], skips: [] };
const part = (label, raw) => ({ label, raw: { ...EMPTY, ...raw } });
const collisions = (m) => m.skips.filter(s => s.stage === 'analyzer.collision');

test('two analyzers claiming the same leaf is recorded, and the second claim is dropped', () => {
  const ts = part('ts', {
    files: ['dup', 'ts-only'],
    fileCtx: { dup: 'app', 'ts-only': 'app' },
    fileNs: { dup: 'app · core', 'ts-only': 'app · core' },
  });
  const dn = part('dotnet', {
    files: ['dup', 'dn-only'],
    fileCtx: { dup: 'Svc', 'dn-only': 'Svc' },
    fileNs: { dup: 'Svc · Core', 'dn-only': 'Svc · Core' },
  });
  const m = mergeRaw([ts, dn]);
  assert.deepEqual(m.files, ['dn-only', 'dup', 'ts-only'], 'the duplicated leaf survives exactly once');
  assert.equal(m.fileCtx.dup, 'app', 'the first claim stands; last-wins is what made this silent');
  assert.equal(m.fileNs.dup, 'app · core');
  assert.deepEqual(collisions(m), [{ stage: 'analyzer.collision', subject: 'dup', reason: 'DUPKEY' }]);
});

test('a duplicate inside ONE analyzer output is the same loss and is recorded too', () => {
  const m = mergeRaw([
    part('ts', { files: ['a', 'a', 'b'], fileCtx: { a: 'app', b: 'app' }, fileNs: { a: 'app · x', b: 'app · x' } }),
    part('dotnet', { files: ['c'], fileCtx: { c: 'Svc' }, fileNs: { c: 'Svc · y' } }),
  ]);
  assert.deepEqual(m.files, ['a', 'b', 'c']);
  assert.deepEqual(collisions(m), [{ stage: 'analyzer.collision', subject: 'a', reason: 'DUPKEY' }]);
});

test('mergeRaw does not sort the array its caller still owns', () => {
  const raw = { ...EMPTY, files: ['b', 'a'] };
  const m = mergeRaw([{ label: 'ts', raw }]);
  assert.deepEqual(raw.files, ['b', 'a'], 'the analyzer output is the caller property, not scratch space');
  assert.deepEqual(m.files, ['a', 'b']);
});

test('the two-part branch carries every key of the wire shape, from both parts', () => {
  const ts = part('ts', {
    files: ['t1'], fileCtx: { t1: 'app' }, fileNs: { t1: 'app · core' },
    edges: [['t1', 't2']], tpEdges: [['t1', 'react']], tpPkgs: ['react'], typeXctxEdges: [['t1', 't2']],
  });
  const dn = part('dotnet', {
    files: ['d1'], fileCtx: { d1: 'Svc' }, fileNs: { d1: 'Svc · Core' },
    edges: [['d1', 'd2']], tpEdges: [['d1', 'System.Text.Json']], tpPkgs: ['System.Text.Json'],
    typeXctxEdges: [['d1', 'd2']],
  });
  const m = mergeRaw([ts, dn]);
  assert.deepEqual(m.files, ['d1', 't1']);
  assert.deepEqual(m.fileCtx, { t1: 'app', d1: 'Svc' });
  assert.deepEqual(m.fileNs, { t1: 'app · core', d1: 'Svc · Core' });
  assert.deepEqual(m.edges, [['t1', 't2'], ['d1', 'd2']]);
  assert.deepEqual(m.tpEdges, [['t1', 'react'], ['d1', 'System.Text.Json']]);
  assert.deepEqual(m.tpPkgs, ['react', 'System.Text.Json']);
  assert.deepEqual(m.typeXctxEdges, [['t1', 't2'], ['d1', 'd2']]);
  assert.deepEqual(m.skips, [], 'both parts reported files and a skips array, so the merge itself minted nothing');
});

test('the single-part branch passes every other key through untouched', () => {
  // every array here carries two out-of-order elements: this branch SPREADS the
  // raw shape, so m[k] and raw[k] are the same object, and over a one-element
  // array an in-place `.sort()` — the plausible "make it deterministic" edit —
  // moves nothing and leaves the pass-through claim unmeasured either way
  const raw = {
    ...EMPTY,
    files: ['b', 'a'], fileCtx: { a: 'app', b: 'app' }, fileNs: { a: 'app · x', b: 'app · y' },
    edges: [['b', 'a'], ['a', 'b']], tpEdges: [['b', 'vue'], ['a', 'react']],
    tpPkgs: ['react', 'preact'], typeXctxEdges: [['b', 'a'], ['a', 'b']],
    skips: [{ stage: 'ts.alias', subject: 'app/tsconfig.json', reason: 'EXTENDS' }],
  };
  const before = structuredClone(raw);
  const m = mergeRaw([{ label: 'ts', raw }]);
  assert.deepEqual(m.files, ['a', 'b'], 'files is the one key this branch reorders');
  assert.deepEqual(m.skips, raw.skips);

  // the snapshot is what makes both halves real: comparing m[k] against raw[k]
  // is deepEqual(x, x) for the aliased keys, and can only catch the branch
  // REPLACING a key — never the two ways it can move one
  const PASSTHROUGH = ['fileCtx', 'fileNs', 'edges', 'tpEdges', 'tpPkgs', 'typeXctxEdges'];
  assert.ok(PASSTHROUGH.length > 0, 'an empty key list would assert nothing in the loop below');
  for (const k of PASSTHROUGH) {
    assert.deepEqual(m[k], before[k], `the merged ${k} must carry what the analyzer reported`);
    assert.deepEqual(raw[k], before[k], `the branch reordered the caller ${k} in place, and the analyzer still owns it`);
  }
});

test('the wire shape does not depend on how many analyzers ran', () => {
  // the authority for that shape is what an analyzer actually returns. Seeding
  // this from the file own EMPTY compares two hand-written key lists and is
  // blind to the drift it exists to catch: a key added to analyze-ts.mjs (or to
  // RawDto) that the spread branch carries and the two-part literal drops.
  withFixture(TWO_CONTEXTS, ({ root }) => {
    const wire = Object.keys(analyzeTs.build(root)).sort();
    assert.ok(wire.length > 0, 'an analyzer returning no keys makes both comparisons below trivially equal');
    const one = mergeRaw([{ label: 'ts', raw: analyzeTs.build(root) }]);
    const two = mergeRaw([
      { label: 'ts', raw: analyzeTs.build(root) },
      part('dotnet', { files: ['z'], fileCtx: { z: 'Svc' }, fileNs: { z: 'Svc · C' } }),
    ]);
    assert.deepEqual(Object.keys(one).sort(), wire,
      'the single-part branch spreads the analyzer output, so its keys are the analyzer keys');
    assert.deepEqual(Object.keys(two).sort(), wire,
      'a key the analyzer emits and the two-part literal drops makes the wire shape depend on how many analyzers ran');
  });
});

test('a loss both analyzers report is one record, and the merge own record sorts into the list', () => {
  // mergeRaw is the only place the two skip lists meet, so a record BOTH
  // analyzers emit is the one dedupe no analyzer can do for itself. The
  // comparator arms are pinned against ICU in determinism.test.mjs; what only
  // this path can lose is the record mergeRaw MINTS — pushed after both parts'
  // own records, it has to sort into the list rather than trail it.
  const shared = () => ({ stage: 'ts.alias', subject: 'app/tsconfig.json', reason: 'EXTENDS' });
  const m = mergeRaw([
    part('ts', {
      files: ['dup', 't'], fileCtx: { dup: 'app', t: 'app' }, fileNs: { dup: 'app · x', t: 'app · x' },
      skips: [shared(), { stage: 'ts.unresolved', subject: 't', reason: 'NOTARGET' }],
    }),
    part('dotnet', {
      files: ['dup', 'd'], fileCtx: { dup: 'Svc', d: 'Svc' }, fileNs: { dup: 'Svc · y', d: 'Svc · y' },
      skips: [{ stage: 'dotnet.unbuilt', subject: 'Svc', reason: 'NOBIN' }, shared()],
    }),
  ]);
  assert.equal(m.skips.filter(s => s.stage === 'ts.alias').length, 1,
    'the same loss reported by both analyzers is one loss, not two');
  assert.deepEqual(m.skips, [
    { stage: 'analyzer.collision', subject: 'dup', reason: 'DUPKEY' },
    { stage: 'dotnet.unbuilt', subject: 'Svc', reason: 'NOBIN' },
    shared(),
    { stage: 'ts.unresolved', subject: 't', reason: 'NOTARGET' },
  ], 'each analyzer own records survive, and the minted collision sorts to the front instead of trailing the parts');
});

test('--ecosystem forces an analyzer past detection, which reads filenames only', () => {
  withFixture({
    'app/src/a.js': 'export const a = 1;\n',
    'app/tsconfig.json': '{"compilerOptions":{"checkJs":true,"allowJs":true}}',
  }, ({ root }) => {
    const eco = detect(root);
    assert.deepEqual({ ts: eco.ts, dotnet: eco.dotnet }, { ts: true, dotnet: false },
      'a tsconfig kept for checkJs is the whole TS evidence detection needs, and there is not one .ts file here');
    const r = run(root);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /analysed 0 files .*\(ecosystem=ts\)/,
      'auto-detection sent the run to the analyzer that finds nothing in this tree');

    // the documented remedy, on the documented misfire: same tree, flag set.
    // This tree carries no .NET either, so the forced run also exits 2 — what
    // is pinned is WHICH analyzer the flag reached, not a successful analysis.
    const forced = run(root, '--ecosystem=dotnet');
    assert.equal(forced.status, 2, forced.stderr);
    assert.match(forced.stderr, /\[dotnet\] analyzing/,
      'the flag reached the analyzer auto-detection did not pick, on the very tree it misfires on');
    assert.equal(/\[ts\] analyzing/.test(forced.stderr), false,
      'and the misfiring analyzer never ran — here too the flag replaces detection rather than adding to it');
  });
  withFixture({
    'svc/Svc.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
    'svc/src/x.cs': 'namespace Svc { class X { } }\n',
  }, ({ root }) => {
    const eco = detect(root);
    assert.deepEqual({ ts: eco.ts, dotnet: eco.dotnet }, { ts: false, dotnet: true });
    const r = run(root, '--ecosystem=ts');
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /\[ts\] analyzing/, 'the flag reached the analyzer detection did not pick');
    assert.equal(r.stderr.includes('[dotnet]'), false,
      'and the detected one never ran — the flag replaces detection, it does not add to it');
  });
});

const DOTNET_SRC = path.join(REPO, 'tools', 'inspector-gadget', 'analyze-dotnet');
const DOTNET_PROJ = path.join(DOTNET_SRC, 'analyze-dotnet.csproj');
// the csproj declares no AssemblyName, so the assembly name the analyzer looks
// for — and the dll it globs bin/ for — is the csproj basename. Deriving it keeps
// a rename from firing the gate below over a healthy tree.
const DOTNET_DLL = path.basename(DOTNET_PROJ, '.csproj') + '.dll';

function dllsUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === DOTNET_DLL) out.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

// bin/ is a build artifact and node --test guarantees no ordering, so it can be
// absent on a fresh clone: build first, then verify the copy carries the dll the
// .NET analyzer actually globs for. A gate that abstains here would report green
// over a merge that never had a second part.
function stageDotnetProject(root, sub) {
  if (dllsUnder(path.join(DOTNET_SRC, 'bin')).length === 0) {
    const b = spawnSync('dotnet', ['build', DOTNET_PROJ, '-c', 'Release'], { encoding: 'utf8' });
    if (b.status !== 0) throw new Error(`dotnet build failed (status ${b.status}): ${b.stderr || b.stdout}`);
  }
  const dst = path.join(root, sub);
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(DOTNET_PROJ, path.join(dst, path.basename(DOTNET_PROJ)));
  fs.cpSync(path.join(DOTNET_SRC, 'bin'), path.join(dst, 'bin'), { recursive: true });
  if (dllsUnder(path.join(dst, 'bin')).length === 0) {
    throw new Error(`staged ${dst} carries no ${DOTNET_DLL}: the .NET half of this case would analyse nothing`);
  }
  return dst;
}

test('a target carrying both ecosystems merges both analyzers into one artifact', () => {
  withFixture({
    'app/src/core/a.ts': "import { b } from './b';\nexport const a = b;\n",
    'app/src/core/b.ts': 'export const b = 1;\n',
  }, ({ root }) => {
    // the staged directory is named for neither the project nor its assembly, so
    // every .NET leaf (assembly/namespace/type) is a string that exists nowhere on
    // disk — which is what tells the two origins apart below without this test
    // knowing a single C# type name
    stageDotnetProject(root, 'svc');

    const eco = detect(root);
    assert.deepEqual({ ts: eco.ts, dotnet: eco.dotnet }, { ts: true, dotnet: true },
      'the fixture must present both ecosystems, or what runs below is a single-analyzer run wearing this title');

    const r = run(root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(htmlPath(root)), true);
    assert.deepEqual(r.json.skipped.byStage.filter(x => x.stage.startsWith('analyzer.')), [],
      'a healthy two-part merge mints no records of its own — a contract/empty/collision record here is the run claiming a loss that did not happen');
    assert.ok(r.json.totals.contexts >= 2,
      `each analyzer contributes at least one context of its own; got ${r.json.totals.contexts}`);

    const p = payloadOf(root);
    const merged = p.filePaths.slice(0, p.fileCount);
    assert.ok(merged.length > 0, 'an empty merged file list satisfies every filter below having measured nothing');
    const onDisk = (leaf) => fs.existsSync(path.join(root, ...leaf.split('/')));
    const tsLeaf = merged.find(f => f.endsWith('.ts') && onDisk(f));
    const dnLeaf = merged.find(f => !onDisk(f));
    assert.ok(tsLeaf, 'the TS half did not survive the merge');
    assert.ok(dnLeaf, 'the .NET half did not survive the merge');

    const fileNodes = Object.values(p.nodes).filter(n => n.kind === 'file' && !n.tp);
    assert.ok(fileNodes.length > 0, 'no first-party leaf reached the payload at all');
    const ctxs = new Set(fileNodes.map(n => n.ctx));
    assert.ok(ctxs.size >= 2,
      `one context over a two-analyzer run means a half was lost or overwritten; got ${[...ctxs].join(', ')}`);

    // BY ORIGIN. Both counts above are satisfied by assemble()'s `other`
    // fallback, so a merge that dropped a part's fileCtx outright still reaches
    // two contexts. Each analyzer names a leaf's context as that leaf's first
    // segment — the context directory for TS, the assembly for .NET — so the
    // mapping is checkable without this test knowing a single C# type name.
    const ctxOf = Object.fromEntries(fileNodes.map(n => [n.title, n.ctx]));
    assert.equal(ctxs.has('other'), false,
      'a leaf whose analyzer-claimed context was dropped in the merge falls back to other');
    assert.equal(ctxOf[dnLeaf], dnLeaf.split('/')[0], 'the .NET leaf keeps the context its analyzer claimed');
    assert.equal(ctxOf[tsLeaf], tsLeaf.split('/')[0], 'and the TS leaf keeps its own');

    const nsNodes = Object.values(p.nodes).filter(n => n.kind === 'namespace' && !n.tp);
    assert.ok(nsNodes.length > 0, 'no first-party namespace node reached the payload, so the label check below would measure nothing');
    assert.ok(nsNodes.every(n => n.label.includes(NS_SEP)),
      'a first-party namespace label is ctx + separator + name from either analyzer; a fileNs lost in the merge collapses to the separator-less other');
  });
});
