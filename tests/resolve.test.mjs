// The TS resolution rules, asserted on the RAW analyzer shape.
//
// resolve() / resolveFile() / readTsconfig() and build()'s source-root walk are
// the highest-churn logic in the repo, and their failure mode is silence: a rule
// that stops firing drops an edge, and a dropped edge renders as a clean
// architecture rather than as an error. Every other suite here drives the CLI and
// measures the artifact, so all of them stay green while the .js rewrite, an
// alias table or the type-only discriminator quietly stops working. A failure in
// this file names the RULE that broke.
//
// Two cases at the bottom pin known BLIND SPOTS as facts, not as intent.

import test from 'node:test';
import assert from 'node:assert/strict';

import { withFixture } from './helpers/fixture.mjs';
import { build } from '../tools/inspector-gadget/analyze-ts.mjs';
import { NS_SEP as NS } from '../tools/inspector-gadget/model.mjs';

// the guard rides here rather than in every case: a tree that analysed to nothing
// satisfies every emptiness claim below without measuring anything
const analyze = (spec) => withFixture(spec, ({ root }) => {
  const raw = build(root);
  assert.ok(raw.files.length > 0, 'the fixture analysed to no files, so nothing below measures anything');
  return raw;
});
const arrows = (pairs) => pairs.map(([a, b]) => `${a} -> ${b}`).sort();
// the claim "this rule cost nothing" — its premise, that the tree analysed to
// something, is enforced for every case by analyze() above
const noLosses = (raw, why) => assert.deepEqual(raw.skips, [], why);

const ALIAS_TSCONFIG = '{"compilerOptions":{"paths":{"@lib/*":["../lib/src/*"]}}}';

test('a relative sibling and a relative parent both resolve to file edges', () => {
  const raw = analyze({
    'app/src/core/a.ts':
      "import { s } from './sib';\n" +
      "import { p } from '../shared/p';\n" +
      'export const a = s + p;\n',
    'app/src/core/sib.ts': 'export const s = 1;\n',
    'app/src/shared/p.ts': 'export const p = 2;\n',
  });
  assert.deepEqual(arrows(raw.edges), [
    'app/src/core/a.ts -> app/src/core/sib.ts',
    'app/src/core/a.ts -> app/src/shared/p.ts',
  ], './x and ../x are normalized against the importer directory, not against the source root');
  noLosses(raw, 'a relative specifier that resolves must not ALSO reach the failure channel; ts.unresolved recording itself is pinned in failure-channel.test.mjs');
});

test("a '.js' specifier resolves to the .ts and .tsx file the author actually wrote", () => {
  const raw = analyze({
    'app/src/a.ts':
      "import { x } from './x.js';\n" +
      "import { y } from './y.js';\n" +
      'export const a = x + y;\n',
    'app/src/x.ts': 'export const x = 1;\n',
    'app/src/y.tsx': 'export const y = 2;\n',
  });
  assert.deepEqual(arrows(raw.edges), [
    'app/src/a.ts -> app/src/x.ts',
    'app/src/a.ts -> app/src/y.tsx',
  ], 'NodeNext sources import their own siblings as .js; without the noJs rewrite every such edge is lost');
  noLosses(raw, 'this rule resolves, so it must reach the failure channel not at all');
});

test('a directory specifier resolves to index.ts, and to index.tsx', () => {
  // two directories, not one: index.ts wins the candidate loop, so a shared
  // directory would leave the .tsx branch unmeasured
  const raw = analyze({
    'app/src/a.ts':
      "import { t } from './plain';\n" +
      "import { j } from './jsx';\n" +
      'export const a = t + j;\n',
    'app/src/plain/index.ts': 'export const t = 1;\n',
    'app/src/jsx/index.tsx': 'export const j = 2;\n',
  });
  assert.deepEqual(arrows(raw.edges), [
    'app/src/a.ts -> app/src/jsx/index.tsx',
    'app/src/a.ts -> app/src/plain/index.ts',
  ], 'a barrel directory is the common import target; both index extensions are candidates');
  noLosses(raw, 'this rule resolves, so it must reach the failure channel not at all');
});

test('a tsconfig paths WILDCARD resolves across the context boundary', () => {
  const raw = analyze({
    'app/src/a.ts': "import { helper } from '@lib/util/helper';\nexport const a = helper;\n",
    'app/tsconfig.json': ALIAS_TSCONFIG,
    'lib/src/util/helper.ts': 'export const helper = 1;\n',
  });
  assert.deepEqual(arrows(raw.edges), ['app/src/a.ts -> lib/src/util/helper.ts'],
    'the wildcard key matches on the prefix and the remainder replaces the * in the target');
  assert.equal(raw.fileCtx['app/src/a.ts'], 'app',
    'the context is the top-level dir under the root — the exact string aliasOf is keyed by, not the source root');
  assert.equal(raw.fileCtx['lib/src/util/helper.ts'], 'lib',
    'the target is in a different context: the whole point of the alias table is edges the relative resolver cannot see');
  assert.deepEqual(raw.tpPkgs, [], 'an alias that resolves must not also count as a package');
  noLosses(raw, 'this rule resolves, so it must reach the failure channel not at all');
});

test('a tsconfig paths EXACT key resolves, and matches only on equality', () => {
  const raw = analyze({
    'app/src/a.ts': "import { c } from '@config';\nexport const a = c;\n",
    'app/src/b.ts': "import { d } from '@config/deep';\nexport const b = d;\n",
    'app/tsconfig.json': '{"compilerOptions":{"paths":{"@config":["../lib/src/config.ts"]}}}',
    'lib/src/config.ts': 'export const c = 1;\n',
    'lib/src/config/deep.ts': 'export const d = 2;\n',
  });
  assert.deepEqual(arrows(raw.edges), ['app/src/a.ts -> lib/src/config.ts'],
    'a non-wildcard key is an exact specifier match; treating it as a prefix would silently redirect @config/deep');
  assert.deepEqual(raw.tpPkgs, ['@config/deep'],
    'the unmatched specifier falls through to the third-party set rather than resolving');
  noLosses(raw, 'the third-party set is the whole disposal of a key that did not match; it must not ALSO record ts.unresolved');
});

test('baseUrl shifts the base the alias target is joined against', () => {
  const tree = {
    'app/src/a.ts': "import { u } from '@u/x';\nexport const a = u;\n",
    'app/src/util/x.ts': 'export const u = 1;\n',
  };
  const withBase = analyze({
    ...tree,
    'app/tsconfig.json': '{"compilerOptions":{"baseUrl":"src","paths":{"@u/*":["util/*"]}}}',
  });
  assert.deepEqual(arrows(withBase.edges), ['app/src/a.ts -> app/src/util/x.ts'],
    'the target is relative to baseUrl, so util/* means app/src/util/*');
  noLosses(withBase, 'this rule resolves, so it must reach the failure channel not at all');

  const withoutBase = analyze({
    ...tree,
    'app/tsconfig.json': '{"compilerOptions":{"paths":{"@u/*":["util/*"]}}}',
  });
  assert.deepEqual(arrows(withoutBase.edges), [],
    'without baseUrl the same table means app/util/*, which is nothing — this is what proves baseUrl did the work above');
  assert.deepEqual(withoutBase.tpPkgs, ['@u/x'], 'the missed alias becomes a package, not a skip');
  noLosses(withoutBase, 'a non-relative specifier the alias table missed is a package, never a ts.unresolved record');
});

test('a JSONC tsconfig — comments, trailing commas, a // inside a string — parses and its aliases work', () => {
  const raw = analyze({
    'app/src/a.ts': "import { helper } from '@lib/util/helper';\nexport const a = helper;\n",
    'app/tsconfig.json':
      '{\n' +
      '  // the shape tsc itself accepts\n' +
      '  "compilerOptions": {\n' +
      '    /* a block comment\n' +
      '       across lines */\n' +
      '    "someUrl": "http://example.invalid/not-a-comment",\n' +
      '    "paths": {\n' +
      '      "@lib/*": ["../lib/src/*"], // trailing comma below and after\n' +
      '    },\n' +
      '  },\n' +
      '}\n',
    'lib/src/util/helper.ts': 'export const helper = 1;\n',
  });
  noLosses(raw, 'a JSONC config tsc accepts must not record ts.tsconfig; the // inside the string value must survive stripping');
  assert.deepEqual(arrows(raw.edges), ['app/src/a.ts -> lib/src/util/helper.ts'],
    'parsing is only half of it — the table read out of the stripped text has to be the real one');
});

test('a whole-statement `import type` crossing a context is excluded from edges and lands in typeXctxEdges', () => {
  const raw = analyze({
    'app/src/a.ts': "import type { T } from '@lib/util/index';\nexport type A = T;\n",
    'app/src/b.ts': "import { helper } from '@lib/util/index';\nexport const b = helper;\n",
    'app/tsconfig.json': ALIAS_TSCONFIG,
    'lib/src/util/index.ts': 'export const helper = 1;\nexport type T = number;\n',
  });
  assert.deepEqual(arrows(raw.edges), ['app/src/b.ts -> lib/src/util/index.ts'],
    'a type-only import is erased at build time, so it cannot participate in a runtime cycle');
  assert.deepEqual(arrows(raw.typeXctxEdges), ['app/src/a.ts -> lib/src/util/index.ts'],
    'the coupling is still real at the design level, so it is collected rather than dropped');
});

test('a whole-statement `import type` inside one context lands in neither edges nor typeXctxEdges', () => {
  const raw = analyze({
    'app/src/a.ts': "import type { T } from './t';\nexport type A = T;\n",
    'app/src/c.ts': "import { v } from './t';\nexport const c = v;\n",
    'app/src/t.ts': 'export const v = 1;\nexport type T = number;\n',
  });
  assert.deepEqual(arrows(raw.edges), ['app/src/c.ts -> app/src/t.ts'],
    'the value import proves the resolver reached ./t at all, so the absences below are decisions and not a dead fixture');
  assert.deepEqual(raw.typeXctxEdges, [],
    'typeXctxEdges is the CROSS-context collector; a same-context type-only import is coupling the design already accepts');
});

test('third-party specifiers are reduced to their package root, and node: builtins to nothing', () => {
  const raw = analyze({
    'app/src/a.ts':
      "import { jsx } from 'react/jsx-runtime';\n" +
      "import { jsxs } from 'react/jsx-dev-runtime';\n" +
      "import { deep } from '@scope/name/deep';\n" +
      "import fs from 'node:fs';\n" +
      'export const a = [jsx, jsxs, deep, fs];\n',
  });
  assert.deepEqual([...raw.tpPkgs].sort(), ['@scope/name', 'react'],
    'a scoped package root is two segments and an unscoped one is one; a node: builtin is not a dependency of the codebase at all');
  assert.deepEqual(arrows(raw.tpEdges), [
    'app/src/a.ts -> @scope/name',
    'app/src/a.ts -> react',
  ], 'the edge carries the package root, so two subpaths of one package are one arrow');
  assert.deepEqual(raw.edges, [], 'nothing here resolves to a scanned file');
  noLosses(raw, 'a non-relative specifier that misses is a package, never an unresolved module');
});

test("a side-effect import (import 'x') is an edge when it resolves and a package when it does not", () => {
  const raw = analyze({
    'app/src/a.ts': "import './sib';\nimport 'lodash';\nexport const a = 1;\n",
    'app/src/sib.ts': 'export const s = 1;\n',
  });
  assert.deepEqual(arrows(raw.edges), ['app/src/a.ts -> app/src/sib.ts'],
    'a bare import runs the module — the dependency is as real as a named one');
  assert.deepEqual(raw.tpPkgs, ['lodash']);
  noLosses(raw, 'this rule resolves, so it must reach the failure channel not at all');
});

test('a dynamic import() and a require() are edges when they resolve and packages when they do not', () => {
  const raw = analyze({
    'app/src/a.ts':
      "export async function load() { return import('./dyn'); }\n" +
      "export const c = require('chalk');\n" +
      "export const m = require('./req');\n",
    'app/src/dyn.ts': 'export const d = 1;\n',
    'app/src/req.ts': 'export const r = 1;\n',
  });
  assert.deepEqual(arrows(raw.edges), [
    'app/src/a.ts -> app/src/dyn.ts',
    'app/src/a.ts -> app/src/req.ts',
  ], 'a lazily loaded module is still a dependency; both call shapes feed the same resolver');
  assert.deepEqual(raw.tpPkgs, ['chalk']);
  noLosses(raw, 'this rule resolves, so it must reach the failure channel not at all');
});

test('a context WITH src/ roots there: root files get (root), and a .ts outside src/ is invisible and silent', () => {
  const raw = analyze({
    'app/src/a.ts': 'export const a = 1;\n',
    'app/src/core/b.ts': 'export const b = 2;\n',
    'app/outside.ts': 'export const outside = 3;\n',
  });
  assert.deepEqual(raw.files, ['app/src/a.ts', 'app/src/core/b.ts'],
    'once a context has a src/ the walk starts there and never revisits the context dir (CLAUDE.md states this as the rule)');
  assert.equal(raw.fileNs['app/src/a.ts'], 'app' + NS + '(root)',
    'a file directly in the source root has no first segment to name a namespace with');
  assert.equal(raw.fileNs['app/src/core/b.ts'], 'app' + NS + 'core');
  noLosses(raw, 'the invisibility is silent by design — pinning the fact, since a file the tool never saw cannot be reported as lost');
});

test('a context WITHOUT src/ roots at the context dir itself', () => {
  const raw = analyze({
    'lib/a.ts': 'export const a = 1;\n',
    'lib/sub/b.ts': 'export const b = 2;\n',
  });
  assert.deepEqual(raw.files, ['lib/a.ts', 'lib/sub/b.ts'],
    'a flat context is scanned whole; requiring src/ would make it a zero-file repo');
  assert.equal(raw.fileNs['lib/a.ts'], 'lib' + NS + '(root)');
  assert.equal(raw.fileNs['lib/sub/b.ts'], 'lib' + NS + 'sub',
    'the namespace is the first segment below the source root, which here is the context dir');
});

test('BLIND SPOT: an inline `{ type T }` specifier is counted as a value import', () => {
  // TYPE_ONLY_RE is /^\s+type\b/ over the text between the keyword and `from`,
  // so it sees `type` only when it sits immediately after `import`. This pins the
  // fact, not an intent.
  const raw = analyze({
    'app/src/a.ts':
      "import { type T } from './t';\n" +
      "import type { U } from './u';\n" +
      'export type A = [T, U];\n',
    'app/src/t.ts': 'export type T = number;\n',
    'app/src/u.ts': 'export type U = string;\n',
  });
  assert.deepEqual(arrows(raw.edges), ['app/src/a.ts -> app/src/t.ts'],
    'the inline form is erased by tsc exactly like the whole-statement form, yet only the whole-statement form is excluded here');
  assert.deepEqual(raw.typeXctxEdges, [], 'both imports stay inside one context');
  noLosses(raw, './u resolved and was dropped from edges by the type-only decision — dropped must not also mean reported lost');
});

test('BLIND SPOT: only paths[key][0] is tried; a second fallback candidate is never reached and nothing records it', () => {
  const tree = {
    'app/src/a.ts': "import { helper } from '@lib/util/helper';\nexport const a = helper;\n",
    'lib/src/util/helper.ts': 'export const helper = 1;\n',
  };
  const firstWins = analyze({
    ...tree,
    'app/tsconfig.json': '{"compilerOptions":{"paths":{"@lib/*":["../lib/src/*","../nope/*"]}}}',
  });
  assert.deepEqual(arrows(firstWins.edges), ['app/src/a.ts -> lib/src/util/helper.ts'],
    'the candidate list works when the real target is first — this is what makes the flipped fixture below meaningful');

  const secondIgnored = analyze({
    ...tree,
    'app/tsconfig.json': '{"compilerOptions":{"paths":{"@lib/*":["../nope/*","../lib/src/*"]}}}',
  });
  assert.deepEqual(arrows(secondIgnored.edges), [],
    'tsc walks the candidate list in order; readTsconfig keeps v[0] and drops the rest');
  assert.deepEqual(secondIgnored.tpPkgs, ['@lib/util'],
    'the edge does not vanish quietly — it reappears as an invented package root, which is the misleading half');
  assert.deepEqual(secondIgnored.skips, [],
    'and nothing in the failure channel says a candidate was dropped; this pins the fact, not an intent');
});
