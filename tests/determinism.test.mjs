// Output ordering, and the one exposure that no double-run on one machine can
// catch: `localeCompare` reaches artifact bytes and the stdout JSON, so two
// hosts with different ICU data or a different default locale emit different
// orderings from identical input. model.mjs already rules that data order must
// not depend on ICU; render.mjs is the same data under a different roof.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { withFixture, run, REPO } from './helpers/fixture.mjs';

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
