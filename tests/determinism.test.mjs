// Output ordering, and the one exposure that no double-run on one machine can
// catch: `localeCompare` reaches artifact bytes and the stdout JSON, so two
// hosts with different ICU data or a different default locale emit different
// orderings from identical input. model.mjs already rules that data order must
// not depend on ICU; render.mjs is the same data under a different roof.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { withFixture, run, htmlPath, payloadOf, REPO } from './helpers/fixture.mjs';
import { NS_SEP, sortSkips, byStage } from '../tools/inspector-gadget/model.mjs';
import * as analyzeTs from '../tools/inspector-gadget/analyze-ts.mjs';

const RENDER = fs.readFileSync(path.join(REPO, 'tools', 'inspector-gadget', 'render.mjs'), 'utf8');

// names whose ordinal and locale orders DISAGREE — an ordinal comparator emits
// uppercase first, ICU collation interleaves case. A fixture of same-case names
// would pass under either and prove nothing.
const ordinal = (xs) => [...xs].sort();

test('namespace order is ordinal, not ICU collation', () => {
  withFixture({
    'app/src/App/a.ts': 'export const a = 1;\n',
    'app/src/Zed/b.ts': 'export const b = 1;\n',
    'app/src/apple/c.ts': 'export const c = 1;\n',
    'app/src/zebra/d.ts': 'export const d = 1;\n',
  }, ({ root }) => {
    const r = run(root, '--ecosystem=ts');
    assert.equal(r.status, 0, r.stderr);
    const names = r.json.namespaces.map(n => n.name);
    assert.equal(names.length, 4, 'the fixture must produce all four namespaces');
    assert.notDeepEqual(names, [...names].sort((x, y) => x.localeCompare(y)),
      'this case is vacuous unless the two orders actually disagree here');
    assert.deepEqual(names, ordinal(names));
  });
});

test('third-party ties break ordinally', () => {
  withFixture({
    'app/src/core/a.ts': "import Z from 'Zoo';\nimport a from 'apple';\nexport const x = [Z, a];\n",
  }, ({ root }) => {
    const r = run(root, '--ecosystem=ts');
    assert.equal(r.status, 0, r.stderr);
    const pkgs = r.json.thirdParty.map(t => t.package);
    assert.deepEqual(pkgs, ['Zoo', 'apple'], 'equal consumer counts fall through to the name comparator');
  });
});

test('cross-context asymmetry ties break ordinally', () => {
  withFixture({
    'lib/src/x.ts': 'export const x = 1;\n',
    'Zed/src/a.ts': "import { x } from '../../lib/src/x';\nexport const a = x;\n",
    'apple/src/b.ts': "import { x } from '../../lib/src/x';\nexport const b = x;\n",
  }, ({ root }) => {
    const r = run(root, '--ecosystem=ts');
    assert.equal(r.status, 0, r.stderr);
    const froms = r.json.crossCtxAsymmetries.map(a => a.from);
    assert.deepEqual(froms, ['Zed', 'apple'], 'equal edge counts fall through to the name comparator');
  });
});

test('render.mjs reaches no ICU comparator at all', () => {
  assert.equal(RENDER.includes('localeCompare'), false,
    'ordering that lands in the artifact must not depend on the host ICU build or default locale');
});

// TWO_CONTEXTS carries three files, no cycle and one package, so byte-identity
// over it says nothing about the orders that exist only at scale. This tree
// carries every ordering arm at once: edge-free islands whose ordinal and ICU
// orders disagree (Echo's namespaces, the files of Alpha · Widgets), a
// three-file SCC (Alpha · gadgets), a namespace cycle (bravo · Core <-> util),
// a context cycle (Charlie <-> delta), third-party packages tied on consumer
// count with one package above the tie, and two recorded skips from two stages.
// Leaf directory names are distinct across contexts on purpose: fileLabel keeps
// the last two segments, so a repeated leaf would tie two labels and the order
// would fall to V8 sort stability instead of the comparator under test.
//
// Every dependency above sits INSIDE one SCC, so the component walk in
// render.mjs triOrder never recursed and its two neighbour comparators sorted
// an empty array (:71) or a one-element one (:104) — measured over this tree:
// 0 inter-component edges at all three levels, cross-context fan-out max 1.
// Foxtrot is the acyclic half. Its Hub namespace fans out ONE-WAY to two
// contexts (Quartz, nickel) and to two sibling namespaces (Zone, axle), and
// both pairs order differently under the two comparators. Each walk's seed
// sorts ordinally ahead of its own targets — Foxtrot before Quartz and nickel,
// Hub before Zone and axle — so both targets are still unvisited when the seed
// is reached and the neighbour sort is what decides between them, rather than
// the root loop reaching them first. Nothing points back into Foxtrot.
const LARGE = {
  'Alpha/src/Widgets/Zebra.ts': 'export const zebra = 1;\n',
  'Alpha/src/Widgets/apple.ts': 'export const apple = 1;\n',
  'Alpha/src/Widgets/Beta.ts': 'export const beta = 1;\n',
  'Alpha/src/gadgets/Ring.ts': "import { orbit } from './orbit';\nexport const ring = orbit;\n",
  'Alpha/src/gadgets/orbit.ts': "import { cog } from './Cog';\nexport const orbit = cog;\n",
  'Alpha/src/gadgets/Cog.ts': "import { ring } from './Ring';\nexport const cog = ring;\n",
  'Alpha/src/Motors/m.ts':
    "import Z from 'Zoo';\nimport a from 'apple';\nimport Q from 'Quux';\n" +
    "import React from 'react';\nexport const m = [Z, a, Q, React];\n",
  'Alpha/src/Motors/broken.ts': "import { gone } from './no-such-module';\nexport const broken = gone;\n",

  'bravo/src/Core/a.ts': "import { b } from '../util/b';\nexport const a = b;\n",
  'bravo/src/util/b.ts': "import { a } from '../Core/a';\nimport React from 'react';\nexport const b = a;\n",
  'bravo/src/Zones/z1.ts': 'export const z1 = 1;\n',
  'bravo/src/Zones/Z2.ts': 'export const z2 = 1;\n',
  'bravo/tsconfig.json': '{"extends":"../base.json"}',

  'Charlie/src/api/x.ts': "import { y } from '../../../delta/src/svc/y';\nexport const x = y;\n",
  'Charlie/src/api/helper.ts': 'export const helper = 1;\n',
  'delta/src/svc/y.ts': "import { x } from '../../../Charlie/src/api/x';\nexport const y = x;\n",
  'delta/src/svc/Aux.ts': 'export const aux = 1;\n',

  'Echo/src/Zulu/a.ts': 'export const a = 1;\n',
  'Echo/src/alpha/b.ts': 'export const b = 1;\n',
  'Echo/src/Bravo/c.ts': 'export const c = 1;\n',

  'Foxtrot/src/Hub/h.ts':
    "import { q } from '../../../Quartz/src/pump/q';\n" +
    "import { n } from '../../../nickel/src/mill/n';\n" +
    "import { z } from '../Zone/z';\nimport { a } from '../axle/a';\n" +
    'export const h = [q, n, z, a];\n',
  'Foxtrot/src/Zone/z.ts': 'export const z = 1;\n',
  'Foxtrot/src/axle/a.ts': 'export const a = 1;\n',
  'Quartz/src/pump/q.ts': 'export const q = 1;\n',
  'nickel/src/mill/n.ts': 'export const n = 1;\n',
};

// the ICU order of the same strings. Every ordinal pin below is vacuous wherever
// the two comparators happen to agree, so each case asserts the disagreement
// against this before pinning the order.
const icuOrder = (xs) => [...xs].sort((a, b) => a.localeCompare(b));

// the label the tool builds for a namespace — pinned literals go through this
// rather than retyping the separator, which is a middle dot and not an ASCII one
const nsLabel = (ctx, leaf) => ctx + NS_SEP + leaf;
const nsNode = (payload, ctx, leaf) => payload.nodes['n:' + nsLabel(ctx, leaf)];
const childLabels = (payload, node) => node.children.map(id => payload.nodes[id].label);
const firstPartyCtxNodes = (payload) =>
  payload.roots.filter(id => id !== payload.thirdPartyCtxId).map(id => payload.nodes[id]);

test('a large fixture renders byte-identically across runs, cycles and skips included', () => {
  withFixture(LARGE, ({ root }) => {
    const a = run(root, '--ecosystem=ts');
    assert.equal(a.status, 0, a.stderr);
    const htmlA = fs.readFileSync(htmlPath(root), 'utf8');
    const b = run(root, '--ecosystem=ts');
    assert.equal(b.status, 0, b.stderr);

    const t = a.json.totals;
    assert.ok(t.fileCycles > 0 && t.nsCycles > 0 && t.ctxCycles > 0,
      `all three SCC levels must carry a cycle or this measures no cycle ordering at all: ${JSON.stringify(t)}`);
    assert.ok(a.json.skipped.total > 0, 'an empty skip list leaves the skip ordering and the HTML skip table unexercised');
    const tpCounts = a.json.thirdParty.map(p => p.consumers);
    assert.ok(tpCounts.length > new Set(tpCounts).size,
      'the third-party ranking must carry a tie or its name tie-break never runs');

    assert.equal(a.stdout, b.stdout, 'the JSON summary is data: identical input must emit identical bytes');
    assert.equal(a.stderr, b.stderr, 'the human report gets diffed across runs, so it is data too');
    assert.equal(htmlA, fs.readFileSync(htmlPath(root), 'utf8'),
      'consumers commit the artifact; a dirty diff over an unchanged tree is the failure this pins');
  });
});

test('the raw file list is ordinal-sorted, not ICU-sorted', () => {
  withFixture(LARGE, ({ root }) => {
    const files = analyzeTs.build(root).files;
    assert.ok(files.length > 0, 'an empty walk satisfies any ordering claim');
    assert.notDeepEqual(ordinal(files), icuOrder(files),
      'this case is vacuous unless the fixture names order differently under the two comparators');
    assert.deepEqual(files, ordinal(files),
      'file order is the index every payload position is derived from, so it must not vary with host ICU data');
  });
});

test('the context order is ordinal-seeded and dependency-first, down to the neighbour sort', () => {
  withFixture(LARGE, ({ root }) => {
    const r = run(root, '--ecosystem=ts');
    assert.equal(r.status, 0, r.stderr);
    const payload = payloadOf(root);

    const ctxNames = r.json.contexts.map(c => c.name);
    assert.notDeepEqual(ordinal(ctxNames), icuOrder(ctxNames),
      'vacuous unless the two comparators disagree on these context names');
    assert.deepEqual(ctxNames, ['Alpha', 'delta', 'Charlie', 'Echo', 'Quartz', 'nickel', 'Foxtrot', 'bravo'],
      'ordinal seed, walked dependency-first: delta precedes Charlie because Charlie imports it, and Quartz and nickel precede Foxtrot because Foxtrot imports both. Both of contextMajorOrder\'s sorts are pinned here — an ICU seed loop emits Alpha, bravo, delta, Charlie, Echo, Quartz, nickel, Foxtrot, and an ICU neighbour sort swaps Quartz and nickel');

    // Foxtrot's two one-way dependencies are the only pair the DFS neighbour
    // sort decides between: the seed loop reaches Foxtrot before either target
    const targets = ctxNames.filter(c => c === 'Quartz' || c === 'nickel');
    assert.equal(targets.length, 2, 'both dependency targets must reach the summary or the neighbour sort had nothing to order');
    assert.notDeepEqual(ordinal(targets), icuOrder(targets),
      'vacuous unless the two comparators disagree on the two names that sort decides between');
    assert.deepEqual(targets, ordinal(targets),
      'the neighbour sort is ordinal, so the dependency visited first is the ordinally smaller name');

    assert.deepEqual(firstPartyCtxNodes(payload).map(n => n.label), ctxNames,
      'one order reaching two surfaces: buildPayload computes ctxOrder once, hands it to buildTree for the artifact roots and carries it on _meta to buildSummary — this pins that wiring, and the literal above pins the order itself');
  });
});

test('the whole namespace order is pinned, and the tree groups that one order by context', () => {
  withFixture(LARGE, ({ root }) => {
    const r = run(root, '--ecosystem=ts');
    assert.equal(r.status, 0, r.stderr);
    const payload = payloadOf(root);

    // the literal is the discriminator: every comparator in the namespace walk
    // has a fixture-independent order to fail against, rather than a second
    // derivation of itself that moves with it
    const nsNames = r.json.namespaces.map(n => n.name);
    assert.deepEqual(nsNames, [
      nsLabel('Alpha', 'Motors'), nsLabel('Alpha', 'Widgets'), nsLabel('Alpha', 'gadgets'),
      nsLabel('delta', 'svc'), nsLabel('Charlie', 'api'),
      nsLabel('Echo', 'Bravo'), nsLabel('Echo', 'Zulu'), nsLabel('Echo', 'alpha'),
      nsLabel('Quartz', 'pump'), nsLabel('nickel', 'mill'),
      nsLabel('Foxtrot', 'Zone'), nsLabel('Foxtrot', 'axle'), nsLabel('Foxtrot', 'Hub'),
      nsLabel('bravo', 'Core'), nsLabel('bravo', 'util'), nsLabel('bravo', 'Zones'),
    ], 'ordinal at every level: the context runs are ordinal-seeded and dependency-first, and inside a run so is the component walk');

    const treeNs = firstPartyCtxNodes(payload).flatMap(c => childLabels(payload, c));
    assert.ok(treeNs.length > 0, 'the tree must carry namespace nodes for this comparison to compare anything');
    assert.deepEqual(treeNs, nsNames,
      'one order reaching two surfaces: buildTree groups nsOrderAll by ctxOrder for the artifact and buildSummary emits nsOrderAll — this pins that wiring, and the literal above pins the order');

    // each context owns one unbroken run, in the context order pinned above
    const runs = [];
    for (const n of nsNames) {
      const c = n.split(NS_SEP)[0];
      if (runs[runs.length - 1] !== c) runs.push(c);
    }
    assert.deepEqual(runs, r.json.contexts.map(c => c.name),
      'a context appearing twice would mean the namespace level partitioned on a different context order than the context level');
  });
});

// Before Foxtrot every dependency in this tree sat inside one SCC, so this walk
// ran over empty adjacency: dfs never recursed and its neighbour sort ordered
// nothing. These three namespaces are the only place it has a choice to make.
test('namespace components are walked dependency-first, and that walk breaks ties ordinally', () => {
  withFixture(LARGE, ({ root }) => {
    const r = run(root, '--ecosystem=ts');
    assert.equal(r.status, 0, r.stderr);

    const nsNames = r.json.namespaces.map(n => n.name);
    const fox = nsNames.filter(n => n.startsWith('Foxtrot' + NS_SEP));
    assert.deepEqual(fox, [nsLabel('Foxtrot', 'Zone'), nsLabel('Foxtrot', 'axle'), nsLabel('Foxtrot', 'Hub')],
      'Hub imports both siblings and neither imports anything, so the post-order walk emits both dependencies before Hub — a walk that did not recurse would emit Hub first, at its own ordinal seed position');

    const deps = fox.slice(0, 2);
    assert.notDeepEqual(ordinal(deps), icuOrder(deps),
      'vacuous unless the two comparators disagree on the two names the neighbour sort decides between');
    assert.deepEqual(deps, ordinal(deps),
      'both are unvisited when the walk reaches Hub, so their order is that neighbour sort and it must not vary with host ICU data');
  });
});

test('third-party ranks by consumer count first, then ordinally', () => {
  withFixture(LARGE, ({ root }) => {
    const r = run(root, '--ecosystem=ts');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.thirdParty, [
      { package: 'react', consumers: 2 },
      { package: 'Quux', consumers: 1 },
      { package: 'Zoo', consumers: 1 },
      { package: 'apple', consumers: 1 },
    ]);
    const pkgs = r.json.thirdParty.map(t => t.package);
    assert.notDeepEqual(pkgs, ordinal(pkgs),
      'the count arm is unmeasured unless a name-only ranking would order these differently');
    const tied = pkgs.slice(1);
    assert.notDeepEqual(ordinal(tied), icuOrder(tied),
      'the tie-break arm is unmeasured unless the two comparators disagree on the tied names');

    // the artifact's package nodes come from model.tpPackages, a sort of its own
    // — a different order from the count ranking above, and its own exposure
    const payload = payloadOf(root);
    const tpNs = childLabels(payload, payload.nodes[payload.thirdPartyCtxId]);
    assert.equal(tpNs.length, pkgs.length, 'every ranked package must reach the artifact as a node');
    assert.notDeepEqual(ordinal(tpNs), icuOrder(tpNs), 'vacuous unless the two comparators disagree on these package names');
    assert.deepEqual(tpNs, ordinal(tpNs));
  });
});

test('file order inside a namespace is ordinal', () => {
  withFixture(LARGE, ({ root }) => {
    assert.equal(run(root, '--ecosystem=ts').status, 0);
    const payload = payloadOf(root);
    const ns = nsNode(payload, 'Alpha', 'Widgets');
    assert.ok(ns, 'the fixture must carry the namespace this case measures');
    const labels = childLabels(payload, ns);
    assert.equal(labels.length, 3, 'all three files must land under it');
    assert.notDeepEqual(ordinal(labels), icuOrder(labels), 'vacuous unless the two comparators disagree here');
    assert.deepEqual(labels, ['Widgets/Beta.ts', 'Widgets/Zebra.ts', 'Widgets/apple.ts'],
      'these three import nothing, so each is its own component and the comparator alone decides sibling order');
  });
});

test('file order inside a cycle SCC is ordinal', () => {
  withFixture(LARGE, ({ root }) => {
    assert.equal(run(root, '--ecosystem=ts').status, 0);
    const payload = payloadOf(root);
    const ns = nsNode(payload, 'Alpha', 'gadgets');
    assert.ok(ns, 'the fixture must carry the namespace this case measures');

    const comps = new Set(ns.children.map(id => payload.fileComp[payload.nodes[id].fi]));
    assert.equal(comps.size, 1,
      'the three files must share one component, or this measures component ordering rather than the member sort inside one');
    assert.ok(payload.cycleComps.includes([...comps][0]),
      'that component must be a real cycle, not three files that happen to sit together');

    const labels = childLabels(payload, ns);
    assert.notDeepEqual(ordinal(labels), icuOrder(labels), 'vacuous unless the two comparators disagree here');
    assert.deepEqual(labels, ['gadgets/Cog.ts', 'gadgets/Ring.ts', 'gadgets/orbit.ts'],
      'members of one SCC are emitted in ordinal label order');
  });
});

test('sortSkips orders on stage, then subject, then reason, ordinally on all three', () => {
  const input = [
    { stage: 'apple.read', subject: 'Zed', reason: 'aerr' },
    { stage: 'Zed.read', subject: 'apple', reason: 'EACCES' },
    { stage: 'apple.read', subject: 'Zed', reason: 'Zerr' },
    { stage: 'Zed.read', subject: 'Zulu', reason: 'EACCES' },
  ];
  // one arm at a time: a single whole-list disagreement is satisfied by the
  // stage arm alone and leaves the other two comparators unmeasured
  assert.ok('Zed.read'.localeCompare('apple.read') > 0, 'the stage arm is vacuous unless the two orders disagree');
  assert.ok('Zulu'.localeCompare('apple') > 0, 'the subject arm is vacuous unless the two orders disagree');
  assert.ok('Zerr'.localeCompare('aerr') > 0, 'the reason arm is vacuous unless the two orders disagree');

  assert.deepEqual(sortSkips(input), [
    { stage: 'Zed.read', subject: 'Zulu', reason: 'EACCES' },
    { stage: 'Zed.read', subject: 'apple', reason: 'EACCES' },
    { stage: 'apple.read', subject: 'Zed', reason: 'Zerr' },
    { stage: 'apple.read', subject: 'Zed', reason: 'aerr' },
  ], 'the skip list reaches the artifact, stderr and the JSON summary, so its order is data like any other');
});

test('byStage ranks desc by count and breaks ties ordinally', () => {
  const skips = [
    { stage: 'many.read', subject: 's1', reason: 'R' },
    { stage: 'Zed.read', subject: 's2', reason: 'R' },
    { stage: 'many.read', subject: 's3', reason: 'R' },
    { stage: 'apple.read', subject: 's4', reason: 'R' },
  ];
  assert.ok('Zed.read'.localeCompare('apple.read') > 0, 'the tie-break arm is vacuous unless the two orders disagree');

  const ranked = byStage(skips);
  assert.deepEqual(ranked, [
    { stage: 'many.read', count: 2 },
    { stage: 'Zed.read', count: 1 },
    { stage: 'apple.read', count: 1 },
  ]);
  const stages = ranked.map(x => x.stage);
  assert.notDeepEqual(stages, ordinal(stages),
    'the count arm is unmeasured unless a name-only ranking would lead with a different stage');
});
