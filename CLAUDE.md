# inspector-gadget — repo guide

This repo hosts **one Claude Code slash command, `/inspector-gadget.rr`**, plus
the node tool it shells out to. It produces a **structural read** of a target
codebase as (a) an interactive **DSM** HTML artifact written into the target's
own directory, and (b) a dense **namespace-level** ASCII overview rendered in
the chat by the slash command. Not advice — interpretation.

The previous .NET CLI (a NuGet `dotnet tool` deliverable) is retired. A small
.NET console helper survives only where the language is uniquely best: reading
PE/IL via `System.Reflection.Metadata` for .NET assemblies. It is **not** a
`dotnet tool` — see the Invariants below.

## Vocabulary

| Term | Meaning |
|---|---|
| **inspector-gadget** | This repo, the Claude Code slash command `/inspector-gadget.rr`, and the node tool it invokes — one name across all three. |
| **structural read** | The operation this tool performs: a dense, structural interpretation of a codebase. Produces the DSM HTML artifact and the in-chat namespace-level overview. Not advice. |
| **context** | Top-level grouping. **TS**: each immediate child dir of `--code-root` (excluding dot-dirs and `node_modules`/`dist`/`build`), dropped if it holds no `.ts`/`.tsx`. **.NET**: each first-party assembly. |
| **namespace** | Second level, labelled `{ctx} · {ns}`. **TS**: first path segment below the context's source root (`src/` if present, else the context dir); files in the source root → `(root)`. **.NET**: C# namespace; types with no namespace → `(root)`. |
| **leaf** | Bottom level. **TS**: a file (`.ts`/`.tsx`, `.d.ts` included). **.NET**: a type. |
| **edge** | A dependency from one leaf to another. **TS**: a value import. **.NET**: type→type, from structural metadata plus decoded method-body IL. |
| **type-only cross-context edge** | TS-only: an `import type`/`export type` crossing a context boundary. Computed into `typeXctxEdges` and carried on the model; no renderer reads it and the summary has no such key. It stays because removing it is a wire change across both analyzers for a distinction the matrix may yet want, and a test pins the current behaviour so it cannot drift unobserved meanwhile. |
| **third-party** | A non-first-party reference. **TS**: the package root of any import the resolver could not resolve to a scanned file, `node:` builtins excluded — the classification is "unresolved", not "matches a manifest", since no `package.json` is ever read. **.NET**: any referenced external assembly. Sinks: never in cycle analysis. |
| **SCC** | Strongly-connected component (Tarjan). A **cycle** at a level = an SCC of size > 1. Computed at file, namespace and context level. |
| **triangular order** | Dependency-first sibling order (the alternative to alphabetical): dependencies pushed down/right, SCC members contiguous. |
| **palette** | Fixed pastel colour sets (`CTX_PALETTE` 8 entries, `NS_PALETTE` 16) assigned by **sorted name** → deterministic across runs. |
| **DSM** | Dependency Structure Matrix — the interactive `codebase-dsm.html` view. Cell `(r, c)` reads "row depends on col". Behaviour: see the DSM section. |
| **analyzer** | Per-ecosystem code producing the **raw shape** `{files, fileCtx, fileNs, edges, tpEdges, tpPkgs, typeXctxEdges, skips}`. Two exist: `analyze-ts.mjs` (in-process node) and `analyze-dotnet/` (BCL-only C# helper invoked via `dotnet run`). |
| **model** | The finalized, ecosystem-agnostic data — palette colours, per-level SCCs, cluster adjacency, ns→files, the merged skip list. Built by `model.mjs#assemble()`. |
| **renderer** | `render.mjs` — turns a model into `codebase-dsm.html` and emits the compact JSON summary on stdout. Authority for that summary's shape. |
| **orchestrator** | `index.mjs` — auto-detects ecosystem(s), dispatches to the matching analyzer(s), merges raw outputs, runs model + render. |
| **wire contract** | The cross-file protocol between `render.mjs` and `assets/dsm.client.js`: node-id prefixes `c:`/`n:`/`f:`, the `{ctx} · {ns}` label shape, and the payload keys. No compile-time link; `tests/payload-integrity.test.mjs` is the link. |
| **skip record** | `{stage, subject, reason}` — one **distinct subject** an analyzer lost or degraded during a run, never one incident. `reason` is a stable classifier (an errno, an exception type name, or a sentinel), never a message. |
| **partial read** | A run that produced an artifact with `skipped.total > 0`. Stated on the stderr report, in the stdout summary, in the HTML, and in the chat header. A partial read is a real read; it is reported, never discarded. |
| **dotnet helper** | `tools/inspector-gadget/analyze-dotnet/` — a BCL-only C# console project (net10.0) invoked via `dotnet run`. NOT a NuGet `dotnet tool`; see the Invariants. |

## Layout

```
.claude/commands/inspector-gadget.rr.md   ◄── the slash command body
tools/inspector-gadget/
  index.mjs            orchestrator: arg parse, ecosystem auto-detect, dispatch, merge
  analyze-ts.mjs       TS/Node analyzer (in-process; regex imports + tsconfig paths)
  analyze-dotnet/      .NET analyzer (C#, BCL-only; invoked via `dotnet run`)
    Program.cs           entry: parse <code-root>, run, emit JSON to stdout
    Analyzer.cs          NDepend-style: assembly→namespace→type via System.Reflection.Metadata
    analyze-dotnet.csproj  net10.0, no PackAsTool
  model.mjs            shared finalize: Tarjan SCC (iterative), palette, cluster adj, sortSkips
  render.mjs           matrix-only payload + template fill → codebase-dsm.html + JSON summary
  posix-path.mjs       Node `path.posix` port — keeps TS resolution stable across OSes
  assets/
    template.html        page skeleton (matrix-only — no tabs, no graph pane)
    template.css         page CSS
    dsm.client.js        matrix renderer (vanilla DOM; reads global DATA)
tests/
  helpers/fixture.mjs  temp-tree fixture builder + CLI driver
  failure-channel.test.mjs    the skip channel and the exit ladder, end to end
  payload-integrity.test.mjs  the render → dsm.client.js wire contract
package.json        `npm test` only — private, no dependencies, no `main`/`bin`
install.bat         mirrors only the slash-command .md into ~/.claude/commands/
LICENSE             MIT
.gitignore .gitattributes
```

## Pipeline (data flow)

`/inspector-gadget.rr <code-root>` →
slash command (in chat) runs **`node C:\Projects\inspector-gadget\tools\inspector-gadget\index.mjs <code-root>`** →
`index.mjs` auto-detects ecosystem(s) by file presence (`*.csproj`/`*.sln` →
.NET; `*.ts*`/`tsconfig*.json` → TS); if both, **both analyzers run and merge**
into one model; `--ecosystem=ts|dotnet|auto` overrides →
analyzer(s) produce the **raw shape**
`{files, fileCtx, fileNs, edges, tpEdges, tpPkgs, typeXctxEdges, skips}` →
`index.mjs#mergeRaw` concatenates, dedupes and ordinal-sorts the skip lists, and
**refuses with exit 2 if zero files survived** →
`model.mjs#assemble(raw)` finalizes (palette colours, three Tarjan SCCs at
file/namespace/context, cluster lists, ns→files, `model.skips`) →
`render.mjs#render(model, cfg)` builds payload, fills template with inlined CSS
+ matrix client + the skips block, writes **`<code-root>/codebase-dsm.html`**,
prints a human report to **stderr** and a compact JSON summary to **stdout** →
slash command parses stdout and emits the ASCII namespace-level tables in chat.

## CLI contract

- **stdout** — the compact JSON summary the slash command consumes. Its shape is
  enumerated in `.claude/commands/inspector-gadget.rr.md` step 4; `render.mjs#buildSummary`
  is the authority. The `skipped` key is **always present**, `total: 0` on a
  clean run — a key that vanishes when clean makes the consumer's existence
  check the thing that breaks.
- **stderr** — the human-readable report: totals, the `skipped:` line, per-level
  cycles, the output path.
- **Exit codes.**
  - `0` — the artifact was written. `skipped.total` may be > 0; a partial read is
    a real read.
  - `1` — usage or precondition: unknown option, unexpected positional, missing
    `<code-root>`, a path that is missing or not a directory, a bad
    `--ecosystem` value, or auto-detection finding neither ecosystem. Nothing
    was analyzed. `-h`/`--help` prints usage and exits `0`.
  - `2` — the analysis produced nothing trustworthy: an analyzer threw, or zero
    files survived the merge. No HTML is written, so the target keeps whatever
    artifact a previous good run left there.
- `--ecosystem=` forces an analyzer when auto-detection picks wrong. Detection
  reads **filenames only** — `.csproj`/`.sln` for .NET, `.ts`/`.tsx`/`tsconfig*.json`
  for TS — so a JavaScript repo carrying a `tsconfig.json` for `checkJs` detects
  as TS and analyses zero files; `--ecosystem` is how you correct it.

## Install / distribution — single hardcoded path, no drift

- The tool lives **only in this repo**, at
  `C:\Projects\inspector-gadget\tools\inspector-gadget\`. There is **no copy in
  `~/.claude/tools/`** — duplicating it there just creates drift.
- The slash command (`.md` file) is mirrored to `~/.claude/commands/` by
  `install.bat` so `/inspector-gadget.rr` is invocable from any project. The
  repo file and the installed file share the same name and are byte-identical;
  both are pinned to the same single hardcoded tool path.
- The `.rr` name is the deployed one: `install.bat` copies
  `.claude/commands/inspector-gadget.rr.md` to
  `%USERPROFILE%\.claude\commands\inspector-gadget.rr.md`. Copying under any
  other name publishes a second command beside the one in use, which is the
  drift this design exists to prevent.
- **If the repo is cloned somewhere other than `C:\Projects\inspector-gadget`**,
  edit the `Locate the tool` step of `.claude/commands/inspector-gadget.rr.md`
  (and re-run `install.bat`) to repoint the pin.

## Build · run · verify

- **Prereqs.** Node.js (any LTS) for the orchestrator and the test suite;
  **.NET 10 SDK** when the target has .NET projects (helper invoked via
  `dotnet run`). No NuGet dependencies, no npm dependencies.
- **Direct run** (bypass the slash command):
  ```
  node tools/inspector-gadget/index.mjs <code-root> [--ecosystem=ts|dotnet|auto]
  ```
  Writes `<code-root>/codebase-dsm.html`; stdout = JSON summary; stderr = report.
- **Slash command:** `/inspector-gadget.rr [code-root]`. With no arg → cwd. The
  command body lives in `.claude/commands/inspector-gadget.rr.md`; it invokes the
  pinned path `C:\Projects\inspector-gadget\tools\inspector-gadget\index.mjs`
  directly (no fallbacks).
- **Building the .NET helper** (first run only):
  ```
  dotnet build tools/inspector-gadget/analyze-dotnet/ -c Release
  ```
  `dotnet run` from `index.mjs` triggers this automatically; cached after.
- **The verification floor for any change here** is `npm test` green plus, for a
  change touching the .NET half, the smoke test below. `npm test` runs
  `node --test "tests/**/*.test.mjs"` — 28 cases, no dependencies. Fixtures are
  built under `os.tmpdir()` at run time; a fixture tree checked into the repo
  would become a context in the tool's own self-scan, and two of the fixtures (a
  plain file named `src`, a dangling symlink) do not survive a `git clone` on
  Windows. Creating the symlink needs Developer Mode; without it that case fails
  loudly rather than skipping.
- **Smoke test the tool:** run it against this repo
  (`node tools/inspector-gadget/index.mjs C:/Projects/inspector-gadget
  --ecosystem=dotnet`) — analyzes the `analyze-dotnet/` assembly, writes a
  ~30 KB HTML, prints a JSON summary. This is the only path that exercises the
  C# helper, which the node suite cannot reach.
- **No CI, decided rather than absent.** This fleet auto-pushes the checked-out
  branch at every turn, so a workflow would fire after publication — a
  notification about code already on the remote, with no gate in front of it.
  The slash command is pinned to a hardcoded absolute path, the .NET half needs
  a local SDK, and the artifact is written into the operator's own target
  directory: no runner reproduces that environment. The gate is `npm test`, run
  by whoever changes the code.

## Invariants — preserve when editing

- **Failure has a channel.** Every site that absorbs a failure — a `catch`, but
  equally an `existsSync` that reads EACCES as absence — in an analyzer or in
  ecosystem detection either records a `{stage, subject, reason}` skip on
  `raw.skips` or throws. A site that does neither is a defect. Detection counts because an
  incomplete scan changes which analyzers run: a tree whose `.csproj` falls
  inside the 5000-directory budget and whose `.ts` falls past it would otherwise
  read as a clean .NET-only codebase. Skips are survivable — exit 0, the artifact is written,
  and the count is stated on all three surfaces; zero files after merge is fatal
  — exit 2, no HTML, so the target's previous artifact survives. The clean-run
  line reads `skipped: none`, never "complete read": the channel vouches for
  what it saw fail, not for coverage.
- **What the read does not cover**, by design and without a per-run record:
  sources that are not `.ts`/`.tsx` on the TS side; compiler-generated .NET
  types (`<>c` display classes, async and iterator state machines); imports the
  three regexes do not match (template-literal dynamic imports, imports inside
  comments or strings); and directories reached only through a symlink. A bare
  specifier that resolves to nothing is classified third-party without a
  manifest to check it against, so a workspace-internal alias can appear as an
  external package.
- **Determinism.** Output (HTML + stdout JSON + stderr report) must diff cleanly
  across runs. Sort node/edge/context lists. JS default sort / `<` mirrors
  ordinal; `localeCompare` is used for the triangular/alpha ordering on both
  the C# helper side and the node side. Insertion-order is preserved where the
  C# original used it (analyzers, cluster adjacency). The skip list is deduped
  on the `(stage, subject, reason)` triple and **ordinal**-sorted by it before
  it leaves an analyzer — `readdir` order is not stable, and display order is
  the renderer's problem, never the data's. `reason` is never an error message
  and `subject` is never an absolute path, for the same reason.
- **Wire contract has no compile-time link, and one test instead.**
  `render.mjs` writes node-id strings (`c:`/`n:`/`f:`) and payload keys that
  `assets/dsm.client.js` consumes by hand. Change one side and you MUST change
  the other; `tests/payload-integrity.test.mjs` asserts the two key sets match
  exactly, in both directions. Look for `WIRE` / `WIRE CONTRACT` comments at the
  top of `render.mjs` and `dsm.client.js`.
- **Skips ride the model, not the payload.** `dsm.client.js` rewrites
  `#meta.innerHTML` on every draw, so a payload-borne banner is erased on first
  interaction. `${SKIPS}` is a static template fill placed as a sibling after
  `#meta`. The HTML carries the complete list; stderr and the JSON carry a
  headline plus 20.
- **`fill()` scans the template, never the output.** `${CLIENT}` inlines a JS
  file full of template literals, so an output-side scan for `${` would fire on
  every run of every target. An unknown token in `template.html`, or a value
  nothing consumes, throws rather than shipping a `${...}` into the artifact.
- **BCL-only + Node-stdlib-only.** No external NuGet refs in the helper; no npm
  dependencies in the node side, tests included. Self-contained — the tool runs
  straight out of `tools/inspector-gadget/` with no install step, and the root
  `package.json` is `private` with no `main`, `bin` or `dependencies`.
- **`assets/` are hand-edited static files**, not generated — edit in place.
  Inlined verbatim into the HTML at render time; that is what keeps the
  emitted file runtime-free.
- **`.gitattributes` forces LF** so embedded assets (and the emitted HTML) stay
  byte-stable across platforms; `*.bat` is pinned CRLF.
- **Comment style is terse, LLM-first.** Comments carry only load-bearing
  *why* / invariants + the cross-boundary wire contract — no restatement of
  what the code already says, no decorative dividers. Keep new code in style.
- **The helper is NOT a `dotnet tool`.** No `<PackAsTool>`, no
  `<ToolCommandName>`, no `<Version>`, no NuGet packaging. If you find yourself
  adding any of those, you've misread the goal — the user's distribution
  preference is "no dotnet tool deliverable"; the helper exists only because
  `System.Reflection.Metadata` is the only clean way to read PE/IL.
- **Single source of truth for the tool path.** The tool lives at one pinned
  path; no global copy in `~/.claude/tools/`. If you find yourself adding
  fallback paths or a tool-mirror step to `install.bat`, you're re-introducing
  the drift this design exists to prevent.

## Model conventions

Everything derives from the target's layout — no config file.

**TS/Node:**
- **Context** = each top-level dir under `--code-root` (minus dot-dirs +
  `node_modules`/`dist`/`build`). Contexts with no `.ts/.tsx` never appear.
- **Source root** per context = its `src/` if present, else the dir itself.
  Sibling directories are not walked, so once a context has a `src/`, every
  `.ts` outside it in that context is invisible.
- **Namespace** = first path segment below source root; root files → `(root)`.
- **Cross-context resolution** = each context's `tsconfig*.json`
  `compilerOptions.paths` (+ `baseUrl`), JSONC-tolerant. An `extends` chain is
  **not** followed; a config that defers its `paths` to a base config records a
  `ts.alias` skip and resolution degrades to relative-only.
- **Edges** = value imports (`import/export … from`, side-effect `import '…'`,
  dynamic `import()`/`require()`). Whole-statement `import type` is excluded
  from cycles; cross-context type-only imports are collected into
  `typeXctxEdges`, which reaches the model and no consumer past it.
- **Third-party** = the package root of any non-relative import the resolver
  could not resolve to a scanned file, `node:` excluded. One per package root
  (`react`, `@scope/name`). Pure sinks — matrix row axis only.

**.NET** (NDepend-style):
- **Context** = first-party assembly (discovered from `.csproj` + `bin/`
  output; newest mtime wins). Build the target first — a project with no built
  assembly records a `dotnet.unbuilt` skip and is dropped.
- **Namespace** = C# namespace (root types → `(root)`); context-qualified.
- **Leaf** = type. Edges = type→type via structural metadata (base/interfaces/
  fields/properties/sigs/attributes/generic constraints) + decoded method-body
  IL.
- **Third-party** = every referenced external assembly (`System.*`,
  `Microsoft.*`, NuGet, …). Sinks.
- **No** type-only or cross-context edge concept — those are TS-only.

**Both:** colours assigned from fixed pastel palettes by sorted name →
deterministic.

## DSM (`assets/dsm.client.js`)

Hierarchical NDepend-style DSM: context → namespace → file via
expand/collapse. Cell `(r,c)` = "row depends on col". Triangular
(dependency-first) or alphabetical order; **Direct** or **+ Indirect**
(transitive reachability). Third-party rows pinned at the bottom (purple,
`tpcell`), togglable (`3rd-party / hide`); columns are **first-party only**.
Parent cells aggregate descendants; ancestor/descendant + diagonal render as
"nesting". Click a cell → list the imports behind it. Collapse-all stops at
the namespace level. The skips block sits in the page header, above the
controls, and carries every skipped subject the run recorded.

## Slash-command output (in chat)

Namespace-level only — no per-file rows. Sections (skip a section if empty,
except the read-completeness line, which always prints):

- Header line (title, totals, cycle counts).
- **Read-completeness line** — `skipped: none`, or
  `⚠ PARTIAL READ — {n} subject(s) skipped ({stage} {n}, …)`.
- **Contexts** table — `ctx | ns | files | in→ | out→ | internal`.
- **Namespaces** table — `ctx · ns | files | in→ | out→ | internal`, in
  dependency-first order. First 40 rows; line after if truncated.
- **Context cycles** (if any) — `A ↔ B ↔ … ↔ A` per cycle.
- **Namespace cycles** (if any) — same shape.
- **Cross-context asymmetries** — top 10, `from → to | edges`.
- **Third-party concentration** — top 15, `package | consumers (ns)`.
- **Skipped** (if any) — `stage | subject | reason`, from `skipped.sample`.
- Closing `file://` link to the HTML viewer.

No prose paragraphs. No DSM/SCC explainers. No advice.
