#!/usr/bin/env node
// Orchestrator: detect ecosystem(s) under <code-root>, run the matching
// analyzer(s) (TS in-process; .NET via `dotnet run` helper), merge their raw
// shapes, finalize the shared Model, render codebase-dsm.html.
//
// CLI: inspector-gadget <code-root> [--ecosystem=ts|dotnet|auto] [-h]
//      Aliases: --code-root <dir> / --code-root=<dir> (positional preferred).
//
// EXIT: 0 = artifact written (skips may be > 0 — a partial read is still a read)
//       1 = usage or precondition (bad args, missing/not-a-directory root, no
//           ecosystem detected) — nothing was analyzed
//       2 = the analysis produced nothing trustworthy (an analyzer failed, or
//           zero files after merge). No HTML is written, so the target keeps
//           whatever artifact a previous good run left there.
//
// stdout: compact JSON summary (consumed by the /inspector-gadget slash command).
// stderr: human-readable report.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as analyzeTs from './analyze-ts.mjs';
import { assemble, sortSkips, skipDigest } from './model.mjs';
import { render } from './render.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, 'assets');
const DOTNET_HELPER = path.join(__dirname, 'analyze-dotnet', 'analyze-dotnet.csproj');

const USAGE =
  'usage: inspector-gadget <code-root> [--ecosystem=ts|dotnet|auto] [-h|--help]\n' +
  '\n' +
  '  <code-root>            project root to scan (required, positional)\n' +
  '  --code-root <dir>      alias for the positional arg\n' +
  '  --ecosystem=<v>        ts | dotnet | auto (default: auto-detect)\n' +
  '  -h, --help             show this help and exit\n' +
  '\n' +
  'Writes <code-root>/codebase-dsm.html and prints a JSON summary to stdout.';

export function parseArgs(argv) {
  let help = false, ecosystem = 'auto', root = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { help = true; continue; }
    if (a === '--code-root') { root = argv[++i]; continue; }
    if (a.startsWith('--code-root=')) { root = a.slice('--code-root='.length); continue; }
    if (a === '--ecosystem') { ecosystem = argv[++i]; continue; }
    if (a.startsWith('--ecosystem=')) { ecosystem = a.slice('--ecosystem='.length); continue; }
    if (a.length > 1 && a.startsWith('-')) { throw new Error(`unknown option '${a}'`); }
    if (root == null) { root = a; continue; }
    throw new Error(`unexpected positional '${a}'`);
  }
  return { help, ecosystem, root };
}

// shallow + targeted: walk skipping node_modules/bin/obj/dist/build/.git etc.,
// stop as soon as both flags are set or budget exhausted.
//
// An incomplete scan changes WHICH analyzers run, so it is a loss like any
// other: it records into `skips`, which main() merges into the raw shape. The
// counters additionally sharpen the "no ecosystem found" fatal, so a false
// "nothing here" caused by an ACL or by the budget never reads as a user error.
export const SCAN_BUDGET = 5000;
export function detect(root, budget = SCAN_BUDGET) {
  const skip = new Set(['node_modules', 'bin', 'obj', 'dist', 'build', '.git', '.vs', '.idea']);
  const skips = [];
  const rel = (dir) => path.relative(root, dir).split(path.sep).join('/') || '.';
  let ts = false, dotnet = false, unreadable = 0, exhausted = false;
  function walk(dir) {
    if (ts && dotnet) return;
    if (budget-- <= 0) {
      if (!exhausted) skips.push({ stage: 'detect.budget', subject: '(tree)', reason: 'EXHAUSTED' });
      exhausted = true;
      return;
    }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { unreadable++; skips.push({ stage: 'detect.readdir', subject: rel(dir), reason: (e && (e.code || e.name)) || 'Error' }); return; }
    for (const e of entries) {
      const name = e.name;
      if (e.isDirectory()) {
        if (name.startsWith('.') || skip.has(name)) continue;
        walk(path.join(dir, name));
        if (ts && dotnet) return;
      } else {
        if (!dotnet && (name.endsWith('.csproj') || name.endsWith('.sln'))) dotnet = true;
        if (!ts && (name.endsWith('.ts') || name.endsWith('.tsx') || /^tsconfig.*\.json$/.test(name))) ts = true;
        if (ts && dotnet) return;
      }
    }
  }
  walk(root);
  // a completed scan proves nothing was missed, so its records are dropped: both
  // flags set means the walk returned early by design, not by loss
  return { ts, dotnet, unreadable, exhausted, skips: ts && dotnet ? [] : skips };
}

function runDotnetHelper(root) {
  const res = spawnSync('dotnet', ['run', '--project', DOTNET_HELPER, '-c', 'Release', '--', root], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024, // some codebases have huge type graphs
  });
  if (res.error) throw new Error(`failed to launch dotnet: ${res.error.message}`);
  if (res.status !== 0) {
    process.stderr.write(res.stderr || '');
    throw new Error(`dotnet helper exited ${res.status}`);
  }
  // helper prints build banners to stderr; stdout is the raw JSON only. Those
  // banners are NOT forwarded on success — they vary per build and the report
  // must diff cleanly across runs. The helper's own losses arrive as raw.skips.
  try { return JSON.parse(res.stdout); }
  catch (e) { throw new Error(`could not parse dotnet helper output: ${e.message}`); }
}

// Every raw shape goes through here, single analyzer or two, on ONE path. An
// arity fast path used to skip the body merge; it also skipped the leaf-collision
// rule below, so the rule held only when two analyzers had run — a semantic fork
// wearing a performance rationale. Measured at 20k files: this path costs 10 ms,
// the fast path 2 ms, against 82 ms for assemble() alone on the same input and
// more again for render.
export function mergeRaw(parts) {
  const skips = [];
  for (const { label, raw } of parts) {
    // an absent skips key means "this analyzer cannot say what it lost", which is
    // itself a loss — recorded, never defaulted away to an empty list.
    if (Array.isArray(raw.skips)) skips.push(...raw.skips);
    else skips.push({ stage: 'analyzer.contract', subject: label, reason: 'NOSKIPS' });
    if (raw.files.length === 0 && parts.length > 1) {
      skips.push({ stage: 'analyzer.empty', subject: label, reason: 'NOFILES' });
    }
  }

  const out = { files: [], fileCtx: {}, fileNs: {}, edges: [], tpEdges: [], tpPkgs: [], typeXctxEdges: [] };
  // A leaf claimed twice is index corruption, not a merge: the later claim
  // overwrites the earlier one's context and namespace and the row is counted
  // twice in every per-file tally. The first claim stands and the rest is a loss
  // like any other; sortSkips collapses repeats of the identical record.
  const claimed = new Set();
  for (const { raw } of parts) {
    // before this part's files are claimed, so `in` means "an EARLIER part said so"
    for (const k in raw.fileCtx) if (!(k in out.fileCtx)) out.fileCtx[k] = raw.fileCtx[k];
    for (const k in raw.fileNs) if (!(k in out.fileNs)) out.fileNs[k] = raw.fileNs[k];
    for (const f of raw.files) {
      if (claimed.has(f)) { skips.push({ stage: 'analyzer.collision', subject: f, reason: 'DUPKEY' }); continue; }
      claimed.add(f);
      out.files.push(f);
    }
    out.edges.push(...raw.edges);
    out.tpEdges.push(...raw.tpEdges);
    out.tpPkgs.push(...raw.tpPkgs);
    out.typeXctxEdges.push(...raw.typeXctxEdges);
  }
  out.files.sort(); // deterministic merged order
  out.skips = sortSkips(skips);
  return out;
}

function main(argv) {
  let cli;
  try { cli = parseArgs(argv); }
  catch (e) { process.stderr.write(`error: ${e.message}\n\n${USAGE}\n`); return 1; }
  if (cli.help) { process.stdout.write(USAGE + '\n'); return 0; }
  if (!cli.root) { process.stderr.write(`error: missing <code-root>\n\n${USAGE}\n`); return 1; }

  const root = path.resolve(cli.root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    process.stderr.write(`error: not a directory: ${root}\n`); return 1;
  }

  let want = cli.ecosystem;
  if (!['auto', 'ts', 'dotnet'].includes(want)) {
    process.stderr.write(`error: --ecosystem must be ts|dotnet|auto (got '${want}')\n`); return 1;
  }
  let eco;
  if (want === 'auto') {
    eco = detect(root);
    if (!eco.ts && !eco.dotnet) {
      const why = [];
      if (eco.unreadable) why.push(`${eco.unreadable} director${eco.unreadable === 1 ? 'y was' : 'ies were'} unreadable`);
      if (eco.exhausted) why.push(`the ${SCAN_BUDGET}-directory scan budget was exhausted before the tree was covered`);
      process.stderr.write(`error: no .csproj/.sln and no .ts/tsconfig found under ${root}\n` +
        (why.length ? `       detection was incomplete: ${why.join('; ')}.\n` : '') +
        `       use --ecosystem to force one if your layout is unusual.\n`); return 1;
    }
  } else {
    eco = { ts: want === 'ts', dotnet: want === 'dotnet' };
  }

  const parts = [];
  try {
    if (eco.ts) {
      process.stderr.write(`[ts] analyzing ${root}\n`);
      parts.push({ label: 'ts', raw: analyzeTs.build(root) });
    }
    if (eco.dotnet) {
      process.stderr.write(`[dotnet] analyzing ${root} (via dotnet run helper)\n`);
      parts.push({ label: 'dotnet', raw: runDotnetHelper(root) });
    }
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`); return 2;
  }

  const raw = mergeRaw(parts);
  if (eco.skips?.length) raw.skips = sortSkips([...raw.skips, ...eco.skips]);

  // An empty model is not a result: rendering it writes three "acyclic ✓" lines
  // and a 20 KB matrix over an analysis that never happened, destroying the
  // target's previous artifact on the way. Refuse before assemble().
  if (raw.files.length === 0) {
    const ecos = [eco.ts ? 'ts' : null, eco.dotnet ? 'dotnet' : null].filter(Boolean).join('+');
    process.stderr.write(
      `error: analysed 0 files under ${root} (ecosystem=${ecos})\n` +
      `       contexts come from SUBDIRECTORIES of the code root, so a flat project\n` +
      `       whose sources sit at the root has nothing to analyze — point at the parent.\n` +
      (raw.skips.length ? `       ${raw.skips.length} subject(s) were skipped: ${skipDigest(raw.skips)}\n` : ''));
    return 2;
  }

  const model = assemble(raw);

  const title = path.basename(root) || root;
  const outputDsm = path.join(root, 'codebase-dsm.html');
  // fill() throws on a template/renderer mismatch. main() owns the exit ladder,
  // so that has to arrive as a 2 rather than as an uncaught stack trace.
  try { render(model, { root, title, outputDsm, assetsDir: ASSETS_DIR }); }
  catch (e) { process.stderr.write(`error: ${e.message}\n`); return 2; }
  return 0;
}


// importable for tests; only the direct invocation runs the CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
