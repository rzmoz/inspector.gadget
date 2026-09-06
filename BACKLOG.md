# BACKLOG.md — inspector-gadget

**Pickup line (for any session):** run `node C:/Projects/george.jetson/politburo/tools/check.mjs .`
**first**, read this header, take the highest section with a workable status, **re-measure every row
you pick up against the current tree while writing the plan**, do the work, commit it, remove the row.

**Scope.** This repo is single-purpose: one backlog, at the root, for every open item it owns. A row
here never names another repo's work — citing another repo as evidence is a different thing and is
always allowed.

**Deferrals live here; boundaries live in [`CLAUDE.md`](CLAUDE.md).** The discriminator is decision
vs intention. A deferral — something someone will act on — belongs in this file. A boundary —
decided out of scope, *this is not done and will not be, because X* — stays in the `CLAUDE.md` it
describes. The absence of CI is a boundary and lives there; so does the state of `typeXctxEdges`.

## Standing contract

Binds every row in this file.

| Rule | |
|---|---|
| **Statuses are closed** | `todo` · `pending-yolo` · `blocked/<on>` · `parked` · `done` — nothing outside this set |
| **Done leaves** | a finished row is **removed**, not struck through; git history is its archive. `done` is a transient state between finishing and removing |
| **Status scope** | a status asserts only what it names — a removed row means that row landed, never that its subject is finished |
| **Every row is a claim** | pinned thin on purpose, so re-measure it against the current tree **at plan time whatever its age**; the plan's purpose and goals come from that measurement, not the row's prose |
| **Evidence per row** | every row carries a navigable citation — **where to look, never proof someone finished looking**; a row that cannot produce one is labelled a suspicion in its Item cell |
| **Items are dossiers** | this file loads at pickup, never at launch, so verbosity is wanted: every item captures enough purpose and scope for a session that has nothing else |
| **The gate is `npm test`** | no row is closed on reading alone; a row that changes behaviour lands with a case that was red before it |

**Row schema.** `ID · Target · Item · Evidence · Status`.

## B1 — the regression pins the first gate deliberately left out (2026-09-06)

**Purpose.** The failure channel landed with two suites: `tests/failure-channel.test.mjs` pins the
behaviour that wave changed, `tests/payload-integrity.test.mjs` pins the wire contract it widened.
Everything below is **green today** and unpinned — regression pins for logic that has no gate, not
bug hunts. Each was measured during that wave and carved out of it deliberately, because the wave's
gate was for the behaviour it changed.

**Goals.** Each row lands as its own `node:test` file under `tests/`, zero dependencies, fixtures
built under `os.tmpdir()` by `tests/helpers/fixture.mjs`. `npm test` green. A row that finds a real
defect on its first run fixes it in the same commit and says so, the way `tpCount` was found and
removed by `payload-integrity` on its first run.

| ID | Target | Item | Evidence | Status |
|---|---|---|---|---|
| B1.1 | inspector-gadget | `tests/resolve.test.mjs` — the TS resolution rules, asserted on the raw shape rather than the rendered output so a failure names the rule that broke: relative sibling and parent, `.js`→`.ts` rewrite, `index.ts`/`index.tsx`, tsconfig `paths` wildcard and exact, `baseUrl`, JSONC comments and trailing commas, whole-statement `import type` excluded from cycles, cross-context type-only into `typeXctxEdges`, third-party package-root extraction including `@scope/name` and the `node:` exclusion. Highest-churn logic in the repo and the one place a wrong answer looks like a clean architecture rather than an error | `tools/inspector-gadget/analyze-ts.mjs` `resolve()` `resolveFile()` `readTsconfig()` `pkgRoot()` | `todo` |
| B1.2 | inspector-gadget | `tests/orchestrator.test.mjs` — `mergeRaw` beyond the three cases `failure-channel` already covers: key collisions between two analyzers' `fileCtx`/`fileNs` (silently last-wins today), duplicate entries in `files` (never deduped), and a real dual-ecosystem run over one target. That merge path is exercised only by mixed repos, which is the configuration nobody runs by accident, and its failure mode is silent index corruption | `tools/inspector-gadget/index.mjs` `mergeRaw` | `todo` |
| B1.3 | inspector-gadget | `tests/determinism.test.mjs` — a dedicated double-run over a larger fixture than `failure-channel`'s, plus the one real cross-machine exposure: `triOrder` and `contextMajorOrder` sort with `localeCompare` while the rest of the pipeline is ordinal, so two Node builds with different ICU data can emit different orderings from identical input. Decide at pickup whether the fix is a test or an ordinal comparator | `tools/inspector-gadget/render.mjs` `triOrder` `contextMajorOrder` `lc` | `todo` |
| B1.4 | inspector-gadget | `tests/ports.test.mjs` — the two hand-written ports and the palette, all proven correct today: `posix-path.mjs` differentially against `node:path.posix` (a free oracle, since the file's whole claim is to be a faithful port), Tarjan SCC correctness and determinism, palette assignment by sorted name. A permanently-green differential is also the evidence that would license deleting `posix-path.mjs` and importing `node:path.posix` directly — weigh that at pickup, since it touches the stdlib-only invariant and `CLAUDE.md`'s stated reason for the port | `tools/inspector-gadget/posix-path.mjs`, `tools/inspector-gadget/model.mjs` `tarjan` | `todo` |
