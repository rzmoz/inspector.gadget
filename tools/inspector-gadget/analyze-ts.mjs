// Node/TypeScript analyzer — port of Analyzer/NodeAnalyzer.cs.
// Walks .ts/.tsx under each context's source root, resolves relative + tsconfig-
// path imports → file edges, collects non-relative imports as third-party, returns
// the RAW shape (files/fileCtx/fileNs/edges/tpEdges/tpPkgs/typeXctxEdges/skips) the
// shared model.mjs consumes. Faithful to the C# regex set + tsconfig handling.
//
// FAILURE CHANNEL: nothing here is absorbed silently. Every read that can fail
// pushes a {stage,subject,reason} record onto `skips`; the orchestrator decides
// whether the surviving analysis is still a result. A catch that neither records
// nor throws is a defect in this file.

import fs from 'node:fs';
import path from 'node:path';
import * as posix from './posix-path.mjs';
import { sortSkips } from './model.mjs';

export const DEFAULT_EXCLUDES = ['node_modules', 'dist', 'build'];
const NS_SEP = ' · '; // " · " — keep in sync with model.mjs / dsm.client.js wire

const FROM_RE = /\b(?:import|export)\b([^'";]*?)\bfrom\s*['"]([^'"]+)['"]/g;
const SIDE_RE = /\bimport\s+['"]([^'"]+)['"]/g;
const DYN_RE = /(?:\bimport\b|\brequire)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const TYPE_ONLY_RE = /^\s+type\b/;
const TSCONFIG_RE = /^tsconfig.*\.json$/;
// A relative specifier worth reporting when it resolves to nothing: one the
// resolver was SUPPOSED to be able to resolve. The extension set is derived from
// resolveFile's candidates below and nowhere else — a second hand-maintained list
// drifts, and a deny-by-omission list over an open set of asset extensions is the
// wrong shape. `./styles.css` / `./logo.svg` are assets, not lost modules.
const RESOLVABLE_EXTS = ['.ts', '.tsx', '.js'];
const MODULE_SPEC_RE = new RegExp(`(^|/)[^/.]+$|(${RESOLVABLE_EXTS.map(e => '\\' + e).join('|')})$`);

// reason is a STABLE CLASSIFIER, never e.message: messages carry absolute paths
// and errno prose, and the artifact must diff cleanly across runs and machines.
const skipReason = (e) => (e && (e.code || e.name)) || 'Error';
// subjects are the root-relative POSIX strings the walk already carries; an
// absolute path would embed the machine and the checkout location in the artifact.
const rec = (skips, stage, subject, reason) => { skips.push({ stage, subject, reason }); };

function safeReaddir(dir, subject, skips) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { rec(skips, 'ts.readdir', subject, skipReason(e)); return []; }
}
const namesOf = (entries, pick) => entries.filter(pick).map(d => d.name);
function toNative(posixPath) { return posixPath.split('/').join(path.sep); }
function readText(p) { return fs.readFileSync(p, 'utf8'); } // node's utf8 = no BOM strip equivalent enough for our regex

// JSONC: strip line/block comments + trailing commas (string-aware).
function stripJsonc(text) {
  let out = '', i = 0, n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      out += c; i++;
      while (i < n) {
        const ch = text[i++]; out += ch;
        if (ch === '\\' && i < n) { out += text[i++]; continue; }
        if (ch === '"') break;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

// Returns the alias table, or null when there is none to read. Records like its
// sibling above: ts.tsconfig when the file could not be read or parsed, and
// ts.alias whenever the config carries an `extends` this analyzer does not
// follow — the base config's paths are unread whether or not local ones exist,
// so the record is keyed on the deferral, not on the local table being empty.
function readTsconfig(file, subject, skips) {
  let obj;
  try { obj = JSON.parse(stripJsonc(readText(file))); }
  catch (e) { rec(skips, 'ts.tsconfig', subject, skipReason(e)); return null; }
  if (obj?.extends != null) rec(skips, 'ts.alias', subject, 'EXTENDS');
  const co = obj?.compilerOptions;
  const hasPaths = co && typeof co === 'object' && co.paths && typeof co.paths === 'object';
  if (!hasPaths) return null;
  const baseUrl = typeof co.baseUrl === 'string' ? co.baseUrl : null;
  const pairs = [];
  for (const [k, v] of Object.entries(co.paths)) {
    if (!Array.isArray(v) || v.length === 0) continue;
    const first = typeof v[0] === 'string' ? v[0] : JSON.stringify(v[0]);
    pairs.push([k, first]);
  }
  return { baseUrl, paths: pairs };
}

function replaceFirst(s, ch, rep) {
  const i = s.indexOf(ch);
  return i < 0 ? s : s.slice(0, i) + rep + s.slice(i + 1);
}
function pkgRoot(spec) {
  if (spec.startsWith('node:')) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') && parts.length > 1 ? parts[0] + '/' + parts[1] : parts[0];
}

export function build(root, excludes = DEFAULT_EXCLUDES) {
  const exclude = new Set(excludes);
  const skips = [];

  // discover contexts + source roots from the tree
  const contextDirs = namesOf(safeReaddir(root, '.', skips), d => d.isDirectory())
    .filter(n => !n.startsWith('.') && !exclude.has(n))
    .sort();
  const srcRootOf = Object.fromEntries(contextDirs.map(c =>
    [c, fs.existsSync(path.join(root, c, 'src')) ? c + '/src' : c]));

  // collect source files, tag each with context + namespace
  const files = [];
  const fileCtx = {};
  const fileNs = {};

  function walk(nativeDir, posixDir, ctx, srcRoot) {
    let entries;
    try { entries = fs.readdirSync(nativeDir, { withFileTypes: true }); }
    catch (e) { rec(skips, 'ts.readdir', posixDir, skipReason(e)); return; }
    for (const e of entries) {
      const name = e.name;
      const full = path.join(nativeDir, name);
      if (e.isDirectory()) {
        if (exclude.has(name)) continue;
        walk(full, posixDir + '/' + name, ctx, srcRoot);
      } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
        const r = posixDir + '/' + name;
        files.push(r);
        fileCtx[r] = ctx;
        const rest = r.startsWith(srcRoot + '/') ? r.slice(srcRoot.length + 1) : r;
        const slash = rest.indexOf('/');
        fileNs[r] = ctx + NS_SEP + (slash >= 0 ? rest.slice(0, slash) : '(root)');
      }
    }
  }

  for (const c of contextDirs) {
    const srcRoot = srcRootOf[c];
    walk(path.join(root, toNative(srcRoot)), srcRoot, c, srcRoot);
  }
  files.sort();
  const fileSet = new Set(files);

  // cross-context path aliases from each context's tsconfig
  const aliasOf = {};
  for (const c of contextDirs) {
    const list = [];
    const tsfiles = namesOf(safeReaddir(path.join(root, c), c, skips), d => d.isFile())
      .filter(n => TSCONFIG_RE.test(n)).sort();
    for (const tf of tsfiles) {
      const cfg = readTsconfig(path.join(root, c, tf), c + '/' + tf, skips);
      if (!cfg) continue;
      const baseRel = cfg.baseUrl != null
        ? posix.normalize(posix.join(c, cfg.baseUrl.replace(/\\/g, '/')))
        : c;
      for (const [key, first] of cfg.paths) {
        const target = posix.normalize(posix.join(baseRel, first.replace(/\\/g, '/')));
        if (key.endsWith('/*')) list.push({ wild: true, key: key.slice(0, -2), target });
        else list.push({ wild: false, key, target });
      }
    }
    if (list.length > 0) aliasOf[c] = list;
  }

  // resolve an import specifier to a scanned file (else null)
  function resolveFile(base) {
    const noJs = base.endsWith('.js') ? base.slice(0, -3) : base;
    for (const b of [base, noJs]) {
      for (const cand of [b, b + '.ts', b + '.tsx', b + '/index.ts', b + '/index.tsx']) {
        if (fileSet.has(cand)) return cand;
      }
    }
    return null;
  }
  function resolve(fromFile, spec) {
    if (spec.startsWith('.')) {
      return resolveFile(posix.normalize(posix.join(posix.dirname(fromFile), spec)));
    }
    const aliases = aliasOf[fileCtx[fromFile]];
    if (!aliases) return null;
    for (const a of aliases) {
      if (a.wild) {
        if (spec.startsWith(a.key + '/')) {
          const hit = resolveFile(posix.normalize(replaceFirst(a.target, '*', spec.slice(a.key.length + 1))));
          if (hit) return hit;
        }
      } else if (spec === a.key) {
        const hit = resolveFile(posix.normalize(a.target));
        if (hit) return hit;
      }
    }
    return null;
  }

  // build file→file import edges
  const edges = [];
  const seen = new Set();
  const tpEdges = [];
  const tpSeen = new Set();
  const tpPkgs = new Set();
  const typeXctxEdges = [];
  const txSeen = new Set();

  function addInternal(f, tgt) {
    if (tgt && tgt !== f) {
      const k = f + '\0' + tgt;
      if (!seen.has(k)) { seen.add(k); edges.push([f, tgt]); }
    }
  }
  // a relative specifier never reaches the third-party set, so an unresolved one
  // vanishes entirely — recorded here rather than dropped. One record per FILE:
  // the subject and the reason are both invariant across the file's imports, so
  // ten bad specifiers would push ten identical records for sortSkips to discard.
  let unresolvedIn = null;
  function addExternal(f, spec) {
    if (spec.startsWith('.')) {
      if (MODULE_SPEC_RE.test(spec) && unresolvedIn !== f) {
        unresolvedIn = f;
        rec(skips, 'ts.unresolved', f, 'NOTARGET');
      }
      return;
    }
    const pkg = pkgRoot(spec);
    if (!pkg) return;
    tpPkgs.add(pkg);
    const k = f + '\0' + pkg;
    if (!tpSeen.has(k)) { tpSeen.add(k); tpEdges.push([f, pkg]); }
  }

  for (const f of files) {
    let src;
    try { src = readText(path.join(root, toNative(f))); }
    catch (e) { rec(skips, 'ts.readfile', f, skipReason(e)); continue; }

    let m;
    FROM_RE.lastIndex = 0;
    while ((m = FROM_RE.exec(src)) !== null) {
      const typeOnly = TYPE_ONLY_RE.test(m[1]);
      const tgt = resolve(f, m[2]);
      if (tgt == null) { addExternal(f, m[2]); continue; }
      if (!typeOnly) addInternal(f, tgt);
      else if (fileCtx[f] !== fileCtx[tgt] && tgt !== f) {
        const k = f + '\0' + tgt;
        if (!txSeen.has(k)) { txSeen.add(k); typeXctxEdges.push([f, tgt]); }
      }
    }
    SIDE_RE.lastIndex = 0;
    while ((m = SIDE_RE.exec(src)) !== null) {
      const t = resolve(f, m[1]);
      if (t) addInternal(f, t); else addExternal(f, m[1]);
    }
    DYN_RE.lastIndex = 0;
    while ((m = DYN_RE.exec(src)) !== null) {
      const t = resolve(f, m[1]);
      if (t) addInternal(f, t); else addExternal(f, m[1]);
    }
  }

  return {
    files,
    fileCtx,
    fileNs,
    edges,
    tpEdges,
    tpPkgs: [...tpPkgs],
    typeXctxEdges,
    skips: sortSkips(skips),
  };
}
