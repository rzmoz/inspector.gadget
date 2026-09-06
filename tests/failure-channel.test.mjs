// The failure channel, end to end through the CLI.
//
// Every case here was RED before the channel landed: the tool exited 0, wrote a
// 20 KB matrix and printed three "acyclic ✓" lines over an analysis that had
// lost the subject in question, or never happened at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeFixture, withFixture, danglingSymlink, run, htmlPath, TWO_CONTEXTS, ASSETS, REPO } from './helpers/fixture.mjs';
import { assemble } from '../tools/inspector-gadget/model.mjs';
import * as analyzeTs from '../tools/inspector-gadget/analyze-ts.mjs';
import { render } from '../tools/inspector-gadget/render.mjs';
import { detect, mergeRaw, parseArgs } from '../tools/inspector-gadget/index.mjs';

const stageCounts = (r) => Object.fromEntries(r.json.skipped.byStage.map(x => [x.stage, x.count]));

test('a clean run states completeness affirmatively on all three surfaces', () => {
  withFixture(TWO_CONTEXTS, ({ root }) => {
    const r = run(root, '--ecosystem=ts');
    assert.equal(r.status, 0);
    assert.deepEqual(r.json.skipped, { total: 0, byStage: [], sample: [], omitted: 0 });
    assert.match(r.stderr, /^skipped: none$/m);
    assert.match(fs.readFileSync(htmlPath(root), 'utf8'), /class="skips ok">skipped: none</);
  });
});

test('zero files is fatal: exit 2, no HTML, and the message names the subdirectory rule', () => {
  withFixture({ 'nothing-here/.keep': '' }, ({ root }) => {
    const r = run(root, '--ecosystem=ts');
    assert.equal(r.status, 2);
    assert.equal(r.json, null);
    assert.equal(fs.existsSync(htmlPath(root)), false);
    assert.match(r.stderr, /analysed 0 files/);
    assert.match(r.stderr, /SUBDIRECTORIES/);
  });
});

test('a fatal run leaves the target previous artifact untouched', () => {
  withFixture({ 'nothing-here/.keep': '' }, ({ root }) => {
    const sentinel = '<!-- the last good read -->';
    fs.writeFileSync(htmlPath(root), sentinel, 'utf8');
    assert.equal(run(root, '--ecosystem=ts').status, 2);
    assert.equal(fs.readFileSync(htmlPath(root), 'utf8'), sentinel);
  });
});

test('an unparseable tsconfig degrades alias resolution and says so', () => {
  withFixture({
    'app/src/a.ts': 'export const a = 1;\n',
    'app/tsconfig.json': '{ "compilerOptions": { "paths": { "@lib/*": [ ../lib/src/* ] } } }',
  }, ({ root }) => {
    const r = run(root, '--ecosystem=ts');
    assert.equal(r.status, 0, 'a bad tsconfig is survivable — the sources still read');
    assert.equal(fs.existsSync(htmlPath(root)), true);
    assert.deepEqual(stageCounts(r), { 'ts.tsconfig': 1 });
    assert.equal(r.json.skipped.sample[0].subject, 'app/tsconfig.json');
    assert.equal(r.json.skipped.sample[0].reason, 'SyntaxError');
    assert.match(r.stderr, /PARTIAL READ/);
  });
});

test('a source root that is not a directory loses a context and is recorded', () => {
  withFixture({
    'lib/src/b.ts': 'export const b = 1;\n',
    'app/src': 'a plain file where a source directory is expected\n',
  }, ({ root }) => {
    const r = run(root, '--ecosystem=ts');
    assert.equal(r.status, 0);
    assert.deepEqual(stageCounts(r), { 'ts.readdir': 1 });
    assert.equal(r.json.skipped.sample[0].subject, 'app/src');
    assert.equal(r.json.skipped.sample[0].reason, 'ENOTDIR');
  });
});

test('a file the walk enumerates and the read cannot open is recorded, not skipped over', () => {
  withFixture({ 'app/src/c.ts': 'export const c = 1;\n' }, ({ root }) => {
    danglingSymlink(root, 'app/src/dangling.ts');
    const r = run(root, '--ecosystem=ts');
    assert.equal(r.status, 0);
    assert.deepEqual(stageCounts(r), { 'ts.readfile': 1 });
    assert.equal(r.json.skipped.sample[0].subject, 'app/src/dangling.ts');
    assert.equal(r.json.skipped.sample[0].reason, 'ENOENT');
  });
});

test('aliases deferred to an extends chain are a recorded blind spot, not an absence', () => {
  withFixture({
    'app/src/d.ts': 'export const d = 1;\n',
    'app/tsconfig.json': '{"extends":"../tsconfig.base.json"}',
  }, ({ root }) => {
    const r = run(root, '--ecosystem=ts');
    assert.deepEqual(stageCounts(r), { 'ts.alias': 1 });
    assert.equal(r.json.skipped.sample[0].reason, 'EXTENDS');
  });
});

test('an extends chain is recorded even when the config also carries local paths', () => {
  // the base config's paths are unread either way, so keying the record on the
  // LOCAL table being empty would report the rarest of the three shapes only
  withFixture({
    'app/src/d.ts': 'export const d = 1;\n',
    'lib/src/util/index.ts': 'export const helper = 1;\n',
    'app/tsconfig.json': '{"extends":"../base.json","compilerOptions":{"paths":{"@lib/*":["../lib/src/*"]}}}',
  }, ({ root }) => {
    const r = run(root, '--ecosystem=ts');
    assert.deepEqual(stageCounts(r), { 'ts.alias': 1 });
    assert.equal(r.json.skipped.sample[0].reason, 'EXTENDS');
  });
});

test('an unresolved relative module is recorded once per file; assets and unresolvable extensions are not', () => {
  withFixture({
    'app/src/e.ts':
      "import { x } from './does-not-exist';\n" +
      "import { y } from './also-missing';\n" +
      "import './styles.css';\n" +
      "import logo from './logo.svg';\n" +
      "import { z } from './sibling.mjs';\n" +
      'export const e = x + y + z;\n',
  }, ({ root }) => {
    const r = run(root, '--ecosystem=ts');
    assert.deepEqual(stageCounts(r), { 'ts.unresolved': 1 },
      'two lost modules in one file are one lost subject; .css/.svg are assets; .mjs is an extension the resolver never had a candidate for');
    assert.equal(r.json.skipped.sample[0].subject, 'app/src/e.ts');
    assert.equal(r.json.skipped.sample[0].reason, 'NOTARGET');
  });
});

test('two files each losing a module are two subjects', () => {
  withFixture({
    'app/src/one.ts': "import { a } from './gone';\nexport const one = a;\n",
    'app/src/two.ts': "import { b } from './gone';\nexport const two = b;\n",
  }, ({ root }) => {
    const r = run(root, '--ecosystem=ts');
    assert.deepEqual(stageCounts(r), { 'ts.unresolved': 2 });
    assert.deepEqual(r.json.skipped.sample.map(s => s.subject), ['app/src/one.ts', 'app/src/two.ts']);
  });
});

test('records are stable classifiers: no messages, no absolute paths, no separators from this OS', () => {
  withFixture({
    'app/src/f.ts': "import { x } from './gone';\nexport const f = x;\n",
    'app/tsconfig.json': '{"extends":"../base.json"}',
    'lib/src': 'not a directory\n',
    'zed/src': 'not a directory either\n',
  }, ({ root }) => {
    const skips = run(root, '--ecosystem=ts').json.skipped.sample;
    assert.ok(skips.length >= 3, 'the fixture must actually produce records for this case to measure anything');
    for (const s of skips) {
      assert.match(s.reason, /^[A-Za-z][A-Za-z0-9_]*$/, `reason must be a classifier, got ${JSON.stringify(s.reason)}`);
      assert.match(s.stage, /^[a-z]+\.[a-z-]+$/);
      assert.ok(!s.subject.includes('\\'), `subject must be POSIX, got ${s.subject}`);
      assert.ok(!path.isAbsolute(s.subject), `subject must be root-relative, got ${s.subject}`);
      assert.ok(!s.subject.includes(root), 'subject must not embed the machine path');
    }
  });
});

test('skips are deduped and ordinal-sorted, so the artifact diffs cleanly', () => {
  withFixture({
    'zeta/src': 'not a directory\n',
    'alpha/src': 'not a directory\n',
    'real/src/g.ts': 'export const g = 1;\n',
  }, ({ root }) => {
    const skips = run(root, '--ecosystem=ts').json.skipped.sample;
    assert.equal(skips.length, 2);
    assert.deepEqual(skips.map(s => s.subject), ['alpha/src', 'zeta/src']);
  });
});

test('output is byte-identical across runs, skips included', () => {
  withFixture({
    ...TWO_CONTEXTS,
    'app/src/bad.ts': "import { q } from './nowhere';\nexport const q2 = q;\n",
  }, ({ root }) => {
    const a = run(root, '--ecosystem=ts');
    const htmlA = fs.readFileSync(htmlPath(root), 'utf8');
    const b = run(root, '--ecosystem=ts');
    assert.ok(a.json.skipped.total > 0, 'this case must carry skips or it proves nothing about them');
    assert.equal(a.stdout, b.stdout);
    assert.equal(a.stderr, b.stderr);
    assert.equal(htmlA, fs.readFileSync(htmlPath(root), 'utf8'));
  });
});

test('a precondition failure is exit 1 and analyses nothing', () => {
  withFixture(TWO_CONTEXTS, ({ root }) => {
    assert.equal(run(root, '--ecosystem=perl').status, 1);
    assert.equal(run(path.join(root, 'app', 'tsconfig.json'), '--ecosystem=ts').status, 1);
    assert.equal(fs.existsSync(htmlPath(root)), false);
  });
});

test('detect reports an incomplete scan instead of claiming no ecosystem is present', () => {
  withFixture(TWO_CONTEXTS, ({ root }) => {
    const full = detect(root);
    assert.equal(full.ts, true);
    assert.equal(full.exhausted, false);
    assert.deepEqual(full.skips, [], 'a scan that covered the tree records nothing');
    // budget 1 covers the root call only, so the .ts below it is never reached
    const starved = detect(root, 1);
    assert.equal(starved.ts, false);
    assert.equal(starved.exhausted, true, 'a budget-starved scan must not look like an empty tree');
  });
});

test('an incomplete scan that still finds ONE ecosystem is recorded, not silently narrowed', () => {
  // The .csproj sits inside the budget and the .ts past it: without a record the
  // run is a confident .NET-only read of a mixed repo, exit 0, "skipped: none".
  const spec = { 'svc/Svc.csproj': '<Project Sdk="Microsoft.NET.Sdk" />', 'zzz/z.ts': 'export const z = 1;\n' };
  for (let i = 1; i <= 6; i++) spec[`aaa${i}/sub/.keep`] = '';
  withFixture(spec, ({ root }) => {
    let narrowed = null;
    for (let b = 6; b <= 24 && !narrowed; b++) {
      const r = detect(root, b);
      if ((r.ts || r.dotnet) && (r.exhausted || r.unreadable)) narrowed = r;
    }
    assert.ok(narrowed, 'the fixture must produce a budget where detection succeeds on an incomplete scan');
    assert.equal(narrowed.dotnet, true);
    assert.equal(narrowed.ts, false, 'the TS half is past the budget');
    assert.deepEqual(narrowed.skips, [{ stage: 'detect.budget', subject: '(tree)', reason: 'EXHAUSTED' }]);
  });
});

test('mergeRaw records an analyzer that cannot say what it lost, and one that found nothing', () => {
  const empty = { files: [], fileCtx: {}, fileNs: {}, edges: [], tpEdges: [], tpPkgs: [], typeXctxEdges: [], skips: [] };
  const one = { ...empty, files: ['a'], fileCtx: { a: 'c' }, fileNs: { a: 'c · n' } };

  const contract = mergeRaw([{ label: 'dotnet', raw: { ...one, skips: undefined } }]);
  assert.deepEqual(contract.skips, [{ stage: 'analyzer.contract', subject: 'dotnet', reason: 'NOSKIPS' }]);

  const mixed = mergeRaw([{ label: 'ts', raw: one }, { label: 'dotnet', raw: empty }]);
  assert.deepEqual(mixed.skips, [{ stage: 'analyzer.empty', subject: 'dotnet', reason: 'NOFILES' }]);

  const solo = mergeRaw([{ label: 'ts', raw: empty }]);
  assert.deepEqual(solo.skips, [], 'a single analyzer finding nothing is the zero-files fatal, not a skip record');
});

test('parseArgs rejects what it cannot honour rather than guessing', () => {
  assert.deepEqual(parseArgs(['/x']), { help: false, ecosystem: 'auto', root: '/x' });
  assert.deepEqual(parseArgs(['--ecosystem=ts', '/x']), { help: false, ecosystem: 'ts', root: '/x' });
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
  assert.throws(() => parseArgs(['/a', '/b']), /unexpected positional/);
});

test('the template and the renderer must agree, or nothing is written', () => {
  withFixture(TWO_CONTEXTS, ({ root }) => {
    const model = assemble(analyzeTs.build(root));
    const badAssets = makeFixture({});
    try {
      for (const f of ['template.html', 'template.css', 'dsm.client.js']) {
        fs.copyFileSync(path.join(ASSETS, f), path.join(badAssets.root, f));
      }
      const tpl = path.join(badAssets.root, 'template.html');
      fs.writeFileSync(tpl, fs.readFileSync(tpl, 'utf8') + '\n${NOT_A_TOKEN}\n', 'utf8');
      assert.throws(
        () => render(model, { root, title: 't', outputDsm: htmlPath(root), assetsDir: badAssets.root }),
        /unknown placeholder/,
        'an unknown token must throw, never ship a ${...} into the artifact');
    } finally { badAssets.cleanup(); }
  });
});

test('typeXctxEdges is computed and carried on the model, and reaches no consumer', () => {
  withFixture(TWO_CONTEXTS, ({ root }) => {
    const model = assemble(analyzeTs.build(root));
    assert.equal(model.typeXctxEdges.length, 1, 'the cross-context `import type` must be detected');
    const r = run(root, '--ecosystem=ts');
    assert.equal('typeXctxEdges' in r.json, false, 'the summary carries no such key today');
    const html = fs.readFileSync(htmlPath(root), 'utf8');
    assert.equal(html.includes('typeXctxEdges'), false, 'nor does the artifact — this pins the fact, not an intent');
  });
});

test('the repo own smoke test still passes', () => {
  const r = run(REPO, '--ecosystem=dotnet');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.json.totals.files > 0);
  assert.equal(typeof r.json.skipped.total, 'number');
});
