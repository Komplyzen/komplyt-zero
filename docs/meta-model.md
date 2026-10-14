# Meta-model

`kg_meta_model` returns a **stored** model of how work gets done in a container, a project or for a person, through
one of three lenses:

| Lens | What it describes |
|---|---|
| `methodology` | decision heuristics, quality gates, recovery patterns, structural invariants, organizing concepts |
| `resiliency` | who holds knowledge, bus factor per domain, orphan risk |
| `process` | recurring step sequences per outcome, with transitions and example arcs |

The tool does not compute anything. It reads one row of the `meta_model` table. The hosted service fills that table
every night with a private batch job; a self-hosted install fills it with its own pipeline, or leaves it empty, in
which case the tool answers `status: "not_computed"` (not an error).

## What the tool returns

```json
{ "status": "confident" | "provisional", "explanation": "...", "meta_model": { ... }, "computed_at": "2026-10-09T03:00:00.000Z" }
{ "status": "insufficient", "explanation": "...", "meta_model": null, "computed_at": "..." }
{ "status": "not_computed", "explanation": "No model computed yet for this scope.", "meta_model": null }
{ "status": "error", "explanation": "...", "error_code": "container_not_found" | "invalid_scope" | ... }
```

`computed_at` says how fresh a model is. The shape of `meta_model` per lens is `methodologyMetaModelSchema`,
`resiliencyMetaModelSchema` and `processMetaModelSchema` in `src/contracts.ts`.

## The table (migration `037_meta_model.surql`)

One row per `(container, scope, scope_id, lens)` (unique key):

| Field | |
|---|---|
| `tenant`, `container` | the owner; both required |
| `scope` | `container`, `project` or `person` |
| `scope_id` | `''` for `container`; the project name, or the person's author name (email) |
| `lens` | `methodology`, `resiliency` or `process` |
| `status` | `confident`, `provisional` or `insufficient` |
| `explanation` | text shown to the caller |
| `model` | the lens output as JSON; absent when `status` is `insufficient` |
| `computed_at`, `job_version` | when and by what it was written |

A caller sees a row exactly when they may see its container (the same grant rule as `node`) and the row's `tenant`
is the container's tenant (the table asserts this on write). Tenant connections can never write the table; write it
with a root (admin) connection, like any other maintenance task. Rows are replaced, not appended: upsert on the
unique key.

Two rules for whoever fills the table:

- `model` must have the documented shape for its `lens`. The tool checks it before serving and answers with an
  `internal_error` (logging `job_version`) instead of passing a malformed model to a client.
- Rows belong to live containers. A container that is soft-deleted serves no model (`container_not_found`), and the
  hard purge deletes its `meta_model` rows with it. Remove the rows of anything you delete yourself.

## Plans

On the hosted service the stored meta-models are part of the paid plans (Team, Pro, Enterprise): a workspace on the
free plan is refused every lens, and the nightly job computes nothing for it. The `methodology` lens needs a business
plan (Team or Enterprise); `resiliency` and `process` are included in every paid plan. With `KG_AUTH_MODE=local` there
are no plans and every lens is available.
