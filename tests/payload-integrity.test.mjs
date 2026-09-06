// The render.mjs -> assets/dsm.client.js WIRE CONTRACT, pinned without a browser.
//
// CLAUDE.md calls this contract unenforced: the renderer writes node-id strings
// and payload keys the client consumes by hand, with no compile-time link. These
// cases are that link. A key renamed on one side and not the other is a runtime
// TypeError on a page that has no error channel of its own.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeFixture, run, htmlPath, payloadOf, TWO_CONTEXTS, ASSETS } from './helpers/fixture.mjs';
import { assemble } from '../tools/inspector-gadget/model.mjs';
import * as analyzeTs from '../tools/inspector-gadget/analyze-ts.mjs';
import { render } from '../tools/inspector-gadget/render.mjs';

const CLIENT = fs.readFileSync(path.join(ASSETS, 'dsm.client.js'), 'utf8');
const TEMPLATE = fs.readFileSync(path.join(ASSETS, 'template.html'), 'utf8');

const withRun = (spec, fn) => {
  const fx = makeFixture(spec);
  try {
    const r = run(fx.root, '--ecosystem=ts');
    assert.equal(r.status, 0, r.stderr);
    return fn({ ...fx, r, payload: payloadOf(fx.root), html: fs.readFileSync(htmlPath(fx.root), 'utf8') });
  } finally { fx.cleanup(); }
};

// every `T.<ident>` the client reads, minus the local alias assignments
const clientKeys = () => {
  const hits = [...CLIENT.matchAll(/\bT\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]);
  return [...new Set(hits)].sort();
};

test('every payload key the client reads is a key the renderer emits', () => {
  withRun(TWO_CONTEXTS, ({ payload }) => {
    const wanted = clientKeys();
    assert.ok(wanted.length > 0, 'the scan must find keys or it proves nothing');
    const emitted = new Set(Object.keys(payload));
    const missing = wanted.filter(k => !emitted.has(k));
    assert.deepEqual(missing, [], `dsm.client.js reads payload keys render.mjs does not emit: ${missing.join(', ')}`);
  });
});

test('the renderer emits no payload key the client cannot use', () => {
  withRun(TWO_CONTEXTS, ({ payload }) => {
    const read = new Set(clientKeys());
    const dead = Object.keys(payload).filter(k => !read.has(k));
    assert.deepEqual(dead, [], `render.mjs emits payload keys nothing consumes: ${dead.join(', ')}`);
  });
});

test('the internal summary helper never reaches the wire', () => {
  withRun(TWO_CONTEXTS, ({ payload }) => {
    assert.equal('_meta' in payload, false);
  });
});

test('node ids carry the c:/n:/f: prefixes the client switches on', () => {
  withRun(TWO_CONTEXTS, ({ payload }) => {
    const ids = Object.keys(payload.nodes);
    assert.ok(ids.length > 0, 'the fixture must produce nodes');
    for (const id of ids) assert.match(id, /^[cnf]:/, `node id without a wire prefix: ${id}`);
    for (const id of payload.roots) assert.match(id, /^c:/, 'roots are contexts');
    for (const [id, n] of Object.entries(payload.nodes)) {
      assert.equal(id, n.id, 'the map key and the node id must agree');
      assert.ok(['context', 'namespace', 'file'].includes(n.kind), `unknown node kind: ${n.kind}`);
    }
  });
});

test('namespace labels use the shared separator', () => {
  withRun(TWO_CONTEXTS, ({ payload }) => {
    const ns = Object.values(payload.nodes).filter(n => n.kind === 'namespace' && !n.tp);
    assert.ok(ns.length > 0, 'the fixture must produce first-party namespaces');
    for (const n of ns) assert.ok(n.label.includes(' \u00b7 '), `namespace label lost the separator: ${n.label}`);
  });
});

test('edge endpoints index into filePaths', () => {
  withRun(TWO_CONTEXTS, ({ payload }) => {
    assert.ok(payload.edges.length > 0, 'the fixture must produce edges');
    for (const [a, b] of payload.edges) {
      assert.ok(Number.isInteger(a) && a >= 0 && a < payload.filePaths.length, `edge source out of range: ${a}`);
      assert.ok(Number.isInteger(b) && b >= 0 && b < payload.filePaths.length, `edge target out of range: ${b}`);
    }
  });
});

test('no template placeholder survives into the artifact', () => {
  withRun(TWO_CONTEXTS, ({ html }) => {
    const tokens = [...new Set([...TEMPLATE.matchAll(/\$\{[^}]*\}/g)].map(m => m[0]))];
    assert.ok(tokens.length > 0, 'the template must carry tokens');
    for (const t of tokens) {
      assert.equal(html.includes(t), false, `unsubstituted placeholder in the artifact: ${t}`);
    }
  });
});

test('the skips block renders outside #meta, which the client overwrites on every draw', () => {
  withRun(TWO_CONTEXTS, ({ html }) => {
    assert.match(CLIENT, /meta\.innerHTML\s*=/, 'this case exists because the client rewrites #meta');
    const meta = html.indexOf('<div class="meta" id="meta"></div>');
    const skips = html.indexOf('class="skips');
    assert.ok(meta >= 0 && skips > meta, 'the skips block must follow #meta as a sibling, not sit inside it');
  });
});

test('a partial read carries the COMPLETE skip list into the artifact, not the capped sample', () => {
  const spec = { 'real/src/a.ts': 'export const a = 1;\n' };
  for (let i = 0; i < 25; i++) spec[`ctx${String(i).padStart(2, '0')}/src`] = 'not a directory\n';
  withRun(spec, ({ r, html }) => {
    assert.equal(r.json.skipped.total, 25);
    assert.equal(r.json.skipped.sample.length, 20, 'the JSON sample is capped');
    assert.equal(r.json.skipped.omitted, 5);
    for (let i = 0; i < 25; i++) {
      assert.ok(html.includes(`ctx${String(i).padStart(2, '0')}/src`), `the artifact must carry every subject, missing ctx${i}`);
    }
  });
});

test('subjects and reasons reaching the HTML are escaped', () => {
  const fx = makeFixture(TWO_CONTEXTS);
  try {
    // Windows rejects < > " in a path, so a filesystem-built subject can only
    // ever carry &. render() is driven directly to cover the whole escaper.
    const model = assemble(analyzeTs.build(fx.root));
    model.skips = [{ stage: 'ts.readdir', subject: 'a<b>&"c/src', reason: 'E<X>&"Y' }];
    render(model, { root: fx.root, title: 'esc', outputDsm: htmlPath(fx.root), assetsDir: ASSETS });
    const html = fs.readFileSync(htmlPath(fx.root), 'utf8');
    assert.ok(html.includes('a&lt;b&gt;&amp;&quot;c/src'), 'the subject must be entity-escaped');
    assert.ok(html.includes('E&lt;X&gt;&amp;&quot;Y'), 'and so must the reason');
    assert.equal(html.includes('a<b>&"c/src'), false, 'neither may appear raw');
  } finally { fx.cleanup(); }
});
