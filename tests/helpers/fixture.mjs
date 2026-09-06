// Fixture builder + CLI driver for the suite.
//
// Trees are built under os.tmpdir() at run time, never checked in: two of the
// fixtures below (a plain FILE named `src`, a dangling symlink) do not survive a
// git clone on Windows, and a checked-in tests/ tree of .ts files would also
// become a context in the tool's own self-scan.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
export const TOOL = path.join(REPO, 'tools', 'inspector-gadget', 'index.mjs');
export const ASSETS = path.join(REPO, 'tools', 'inspector-gadget', 'assets');

// spec: { 'app/src/a.ts': 'contents', … } — posix keys, directories implied
export function makeFixture(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-'));
  for (const [rel, contents] of Object.entries(spec)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, 'utf8');
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// The only portable trigger for a path the walk ENUMERATES as a .ts file and the
// read cannot open. Symlink creation needs Developer Mode on Windows; when it is
// unavailable this THROWS rather than skipping the case — a gate that abstains
// reports green having measured nothing.
export function danglingSymlink(root, rel) {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.symlinkSync(path.join(path.dirname(full), 'no-such-target.ts'), full, 'file');
}

export function htmlPath(root) { return path.join(root, 'codebase-dsm.html'); }
export function htmlOf(root) { return fs.readFileSync(htmlPath(root), 'utf8'); }

// the fixture lifecycle lives here, once: cleanup hardening (Windows EBUSY, say)
// then lands in one place rather than in whichever suite remembered it
export function withFixture(spec, fn) {
  const fx = makeFixture(spec);
  try { return fn(fx); } finally { fx.cleanup(); }
}

export function run(root, ...args) {
  const res = spawnSync(process.execPath, [TOOL, root, ...args], { encoding: 'utf8' });
  // a JSON summary is emitted only on the success path; --help and the failure
  // paths write nothing to stdout, and `json` stays null to say exactly that
  const json = res.stdout.startsWith('{') ? JSON.parse(res.stdout) : null;
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

// the payload the artifact actually carries, read back out of the emitted HTML
export function payloadOf(root) {
  const html = fs.readFileSync(htmlPath(root), 'utf8');
  const open = 'const DATA=';
  const i = html.indexOf(open);
  if (i < 0) throw new Error('emitted HTML carries no DATA payload');
  const j = html.indexOf(';</script>', i);
  if (j < 0) throw new Error('emitted HTML DATA payload is unterminated');
  return JSON.parse(html.slice(i + open.length, j));
}

// a two-context tree with a working tsconfig alias, a type-only cross-context
// import and one third-party package — the shape most cases start from
export const TWO_CONTEXTS = {
  'app/src/core/a.ts':
    "import { helper } from '@lib/util/index';\n" +
    "import type { T } from '@lib/util/index';\n" +
    "import React from 'react';\n" +
    'export const a = helper;\n',
  'app/tsconfig.json': '{"compilerOptions":{"paths":{"@lib/*":["../lib/src/*"]}}}',
  'lib/src/util/index.ts': 'export const helper = 1;\nexport type T = number;\n',
};
