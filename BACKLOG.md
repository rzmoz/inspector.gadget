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
