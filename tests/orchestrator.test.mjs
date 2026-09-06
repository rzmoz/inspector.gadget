// mergeRaw beyond the three cases failure-channel already covers.
//
// The merge path is exercised only by a mixed repo — the configuration nobody
// runs by accident — and its failure mode is silent: two analyzers naming one
// leaf overwrote each other's context and namespace and double-counted the row
// in every per-file tally, with nothing on any of the three surfaces.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeRaw } from '../tools/inspector-gadget/index.mjs';

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
