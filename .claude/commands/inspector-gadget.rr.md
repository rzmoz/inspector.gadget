---
description: Structural read of a codebase — interactive DSM matrix HTML + dense in-chat namespace-level tables. TS/Node + .NET (auto-detected).
argument-hint: [code-root]
---

You are running `/inspector-gadget.rr`. Arguments: `$ARGUMENTS`.

## Procedure

1. **Resolve target.** If `$ARGUMENTS` is empty, target = the current working
   directory. Otherwise target = `$ARGUMENTS` (a directory path; first positional
   wins, ignore trailing words). Resolve to absolute via `Bash` if needed.

2. **Locate the tool.** The tool lives at a single hardcoded path:

   ```
   C:\Projects\inspector-gadget\tools\inspector-gadget\index.mjs
   ```

   If that file does not exist, stop. Emit this error verbatim and do not try
   to repair the install:

   > **inspector-gadget tool not found** at
   > `C:\Projects\inspector-gadget\tools\inspector-gadget\index.mjs`.
   >
   > The slash command is pinned to that single location (no fallbacks). Either
   > clone https://github.com/rzmoz/inspector-gadget to `C:\Projects\inspector-gadget`,
   > or edit the `Locate the tool` step of this `.md` to point at wherever the
   > repo lives on this machine.

3. **Run the analyzer.** Invoke:
   `node <tool>/index.mjs <target>`
   Capture stdout (compact JSON summary) and stderr (human-readable report).
   Exit codes:
   - **0** — the artifact was written. `skipped.total` may still be > 0; a
     partial read is a real read and you report it, you do not discard it.
   - **1** — usage or precondition (bad args, target not a directory, no
     ecosystem detected). Nothing was analyzed.
   - **2** — the analysis produced nothing trustworthy (an analyzer failed, or
     zero files after merge). No HTML was written.

   If exit code ≠ 0, print stderr verbatim and stop.

4. **Parse stdout** as JSON. Shape:
   - `title`, `output` (absolute HTML path), `htmlSizeKB`
   - `totals: {files, edges, namespaces, contexts, thirdParty, fileCycles,
     nsCycles, ctxCycles}`
   - `contexts: [{name, ns, files, in, out, internal, colour}]` — context-major
     dep-first order
   - `namespaces: [{name (= "ctx · ns"), leaf, ctx, files, in, out, internal}]`
     — dep-first order, contiguous per context
   - `sccs: {context: string[][], namespace: string[][]}` — file-level SCCs are
     matrix-only, not emitted here
   - `crossCtxAsymmetries: [{from, to, count}]` — A→B with no B→A
   - `thirdParty: [{package, consumers}]` — sorted by consumer count desc
   - `skipped: {total, byStage: [{stage, count}], sample: [{stage, subject,
     reason}], omitted}` — **always present**, `total: 0` on a clean run. One
     record is one distinct subject the analyzer lost or degraded, not one
     incident. `sample` is capped at 20; the complete list is in the HTML.

5. **Emit in chat — namespace level only, no per-file rows.** Use ASCII tables
   (Unicode box-drawing acceptable). Column widths sized to fit. Suggested
   sections, in order:

   - **Header line.** `inspector-gadget · {title} · {output}` then one line
     `files {n} | edges {n} | ns {n} | ctx {n} | 3p {n}` then if any cycles:
     `cycles: ctx {n}, ns {n}, file {n}` else `cycles: none ✓`.
   - **Read-completeness line — unconditional, never skipped as "empty".**
     `skipped: none` when `skipped.total` is 0, else
     `⚠ PARTIAL READ — {total} subject(s) skipped ({stage} {n}, …)`. Silence is
     not the signal for a complete read; the line is always printed.
   - **Contexts** table. Columns: `ctx | ns | files | in→ | out→ | internal`.
     Rows in the order given.
   - **Namespaces** table. Columns: `ctx · ns | files | in→ | out→ | internal`.
     Rows in the order given. If > 40 rows, show the first 40 and add a line
     `… and {N-40} more (see matrix)`.
   - **Context cycles** — print each as `A ↔ B ↔ … ↔ A`. Skip the section if
     none.
   - **Namespace cycles** — same shape. Skip if none.
   - **Cross-context asymmetries** table. Columns: `from → to | edges`. Top 10.
     Skip if empty.
   - **Third-party concentration** table. Columns: `package | consumers (ns)`.
     Top 15. Skip if empty.
   - **Skipped** table — only when `skipped.total` > 0. Columns:
     `stage | subject | reason`, from `skipped.sample`. If `omitted` > 0, add
     `… and {omitted} more (full list in the HTML)`.
   - **Closing line:** `→ matrix viewer: file://{output}` so the user can click
     it open.

6. **Do not** explain what a DSM is, what an SCC is, what each table means, or
   the analyzer's methodology. Do not editorialize. Do not suggest fixes
   (that's outside this command's scope — it interprets, it does not advise).
   No prose paragraphs. If the user asks follow-up questions, then explain.

## Notes

- Ecosystem auto-detects from file presence (`*.csproj`/`*.sln` → .NET via the
  `dotnet run` helper; `*.ts*`/`tsconfig*.json` → TS via in-process node
  analyzer). Pass `--ecosystem=ts` or `--ecosystem=dotnet` through if the user
  forced one.
- First .NET run will spend a few seconds building the helper project — that's
  `dotnet run`, not "the tool is wrong". Subsequent runs are cached.
- A **partial read** is the normal state on an unbuilt solution or a monorepo
  whose `tsconfig` aliases live in an `extends`ed base config. Report it; do
  not treat it as a tool failure and do not re-run.
- The HTML viewer is the deep artifact (file-level matrix, expand/collapse,
  direct/+indirect, third-party toggle, the complete skip list). The in-chat
  tables are the namespace-level overview.
