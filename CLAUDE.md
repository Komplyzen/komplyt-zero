# Knowledge Graph MCP Server Guidelines

## Development Workflow

Before implementing, check whether an existing abstraction already covers the change, and say why a new one is needed if it doesn't. Review your own diff adversarially before opening a PR: what breaks, which edge case is untested, which claim in the docs no longer matches the code. Setup, tests and PR expectations are in `CONTRIBUTING.md`.

## TypeScript Conventions

### Single-Focus Interfaces

Each module does ONE job. If you're adding a second responsibility, extract it.

```typescript
// Good: focused responsibility
export interface EmbeddingProvider { /* only embedding generation */ }
export interface KgDbClient { /* only query execution */ }

// Bad: god object
class KgServer { db, embeddings, tools, mcpProtocol, sessionState, ... }
```

### Loose Coupling

Depend on interfaces, not concrete types. Pass dependencies explicitly through function parameters: every `ToolHandler.execute()` takes its dependencies as arguments and never reaches for a module-level singleton.

```typescript
// Good: injectable dependencies
async execute(
  db: KgDbClient,
  embed: EmbeddingProvider,
  ctx: ToolContext,
  params: RelateParams
): Promise<ToolResult>

// Bad: reaching for globals or constructing internally
async execute(params: RelateParams): Promise<ToolResult> {
  const db = getGlobalDb(); // hidden dependency
}
```

### Error Handling

- Validate input at the boundary with Zod (`contracts.ts` schemas). Tools receive already-validated params and don't re-check shape.
- Tool-level failures return `toolError(code, message)`, not thrown exceptions. See `ERROR_HTTP_STATUS` in `contracts.ts` for the code → HTTP status mapping
- Auth/transport-level failures use typed error classes (e.g. `AuthError` in `auth.ts`), caught once at the protocol boundary (`index.ts`, `bin/mcp.ts`)
- Let unexpected errors propagate to that boundary rather than swallowing them per-call

### Module Organization

- `tools/index.ts` re-exports the tool registry only, with one file per tool (`tools/query.ts`, `tools/relate.ts`, etc.)
- Implementation details stay in their module; only what other modules need is exported
- One concept per file (don't pack unrelated types/handlers together)

## Architecture Principles

### No God Objects

The server is a composition of focused modules:
- `db.ts` — SurrealDB connection factory, tenant-scoped client (`KgDbClient`)
- `tools/` — MCP tool implementations (one file per tool)
- `embed-registry.ts` — embedding provider metadata (settings read and required, default model, dimensions, maxBatch); no I/O
- `embed.ts` — embedding adapters (Cohere, Ollama, fixture), batching wrapper, boot dimension check (Ollama probe: 5 attempts of at most 10s, 1/2/3/4s apart, so at most 60s before the process exits). New provider = one adapter here + one entry in `embed-registry.ts`
- `activation.ts` — decay/activation scoring logic
- `session-prune.ts` — background pruner for `kg_auth_session` rows; nothing may hold a scoped connection longer than the retention window (the stdio CLI signs in per call over the pool for this reason; `db.ts` / `pool.ts` clients throw `ScopedSessionExpiredError` past it). Runs on a timer inside the server: on serverless platforms use CPU-always-allocated (or watch `kg_session_prune_last_success_timestamp_seconds` and `kg_session_rows`), because request-only CPU throttles timers on idle instances
- `secret-guard.ts` — `bearerGuard` for operational endpoints (`/metrics`, `/pool-metrics` when `METRICS_TOKEN` is set)
- `mcp.ts` — MCP protocol handling (routes shared by HTTP + stdio transports)
- `index.ts` — HTTP server wiring (Hono routes, middleware)
- `bin/` — CLI entrypoints (`kg.ts`, `mcp.ts` stdio server, `auth.ts` OAuth login, `reembed.ts` admin tool)

If a module needs more than ~5 exported functions/types serving unrelated concerns, it's doing too much.

### Interface-Based Composition

When behavior varies, define an interface. When testing, provide a fake implementation, not a mocked database.

```typescript
// Acceptable: interface for swappable behavior
export interface EmbeddingProvider {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  dimensions: number;
}

// Cohere implements this in production; tests can pass a fixture/noop provider
```

## Testing Philosophy

### Integration Tests Against Real SurrealDB

Tests MUST verify actual functionality, not JSON parsing theater.

**Tests are dumb consumers of an externally-provisioned database.** They never
create namespaces or databases and never define schema. The ONLY schema
authority is `database/migrations/*.surql`, applied in filename order by the
same migration runner the hosted deployments use (locally, the loop below).
Hand-copied inline schema in tests is forbidden — it drifts (that's how the
edge table stayed `TYPE NORMAL` in fixtures for a month after it became a
relation table).

**Changing the schema:** `000_baseline.surql` is the hosted production schema
at the open-source cut (2026-10-07, after the pre-release migrations, whose
history lives on in the platform), generated with `scripts/schema-info.py
--apply`. It still carries tables the server no longer uses; removing them is
a later migration. Never edit it. Every change is the next numbered
file (`NNN_<description>.surql`, next free number), written so it applies to a
database that already has data: fresh databases run the baseline plus every
later file; hosted databases that predate the baseline were adopted (their
schema was checked against it, then recorded without running it) and only run
later files. Prefer `DEFINE ... OVERWRITE` / `IF NOT EXISTS` and say
in the header what happens to existing records. `scripts/schema-diff.sh` compares two
databases' schemas (records and JWT keys ignored).

**Required test patterns:**
- Connect via `connectTestDb()` from `src/test/connect.ts`, the standard
  `createRootConnection()` factory, env-driven (`KG_DB_URL`/`KG_DB_NS`/`KG_DB_NAME`).
  It refuses `KG_DB_NAME=main` and returns `null` when the DB is down.
- Skips must REPORT as skipped: `beforeEach((ctx) => { if (skipTests) ctx.skip(); })`.
  Never use `if (skipTests) return;` inside a test body, because that counts as PASSED.
- Start from clean data (`wipeData(rootDb)` in `beforeAll`); suites share one
  database and run sequentially (`fileParallelism: false`).
- Tenant-scoped access goes through `dbFactory.createScoped(claims)` against
  the real `kg_server` access from the migrations — no test-local `DEFINE ACCESS`.
- Create known state via actual tool execution (`relateTool.execute(...)`, `queryTool.execute(...)`), not direct DB writes that bypass the code under test
- Verify results via queries

**CI:** the public `ci.yml` is secretless: typecheck, unit tests with fixture embeddings, an `integration` job
(every suite against a throwaway SurrealDB container provisioned by
`scripts/apply-migrations.sh`, `KG_REQUIRE_DB=1`), a `container` job (hadolint on `src/Dockerfile`, then
`scripts/compose-smoke.sh`: the compose stack stays unprivileged, the backend network stays internal, second start works, a changed `KG_JWT_SECRET` fails with the `.env` hint), and `bun audit`, on every PR
including forks. Integration suites run
in a private CI (dispatched by `notify-private.yml`; fork PRs need
a maintainer's `/ok-to-test`; Dependabot PRs are treated the same way). It provisions a run-scoped database
(`ci_<run_id>`) through the migration chain, runs the suites with
`KG_REQUIRE_DB=1` (a missing DB is a FAILURE, never a vacuous green), and drops
the database afterwards, so every run also validates bootstrap-from-zero.
The private CI runs every `*.integration.test.ts` and asserts the count against
the files on disk, so a new suite runs without registration.

Required checks on `main`: `integration-tests` plus the public `typecheck`,
`test`, `audit`. Path-filtered checks (deploy, benchmarks) are deliberately not
required, or a docs-only PR would wait for them forever. A flaky run is re-run,
not bypassed.

**Local SurrealDB for tests** (then apply the migration chain once):
```bash
KG_DB_NAME=test scripts/local-db.sh up
SURREAL_HTTP=http://127.0.0.1:8000 KG_DB_NAME=test scripts/apply-migrations.sh  # fresh DB only; stops on the first error
```

**What to test:**
- `kg_node_create` persists nodes with correct fields
- `kg_query` retrieves by semantic similarity and filters, including spreading activation
- `kg_relate` creates edges between nodes
- `kg_session_start` / `kg_session_end` / `kg_session_info` track activation and decay
- `kg_node_update` modifies status and reactivates

**What NOT to mock:**
- Database operations: the DB IS the functionality
- Embedding generation: use real Cohere or a deterministic fixture provider

**Acceptable mocks:**
- MCP stdin/stdout transport (JSON-RPC framing)
- External HTTP services (when testing error handling)

### Test Location

- Unit/contract tests: co-located `*.test.ts` next to the module they cover (e.g. `tools/query.test.ts`, `contracts.test.ts`)
- Integration tests: `src/test/*.integration.test.ts`, cross-module scenarios against a real SurrealDB

## Git Workflow

Feature branches and pull requests; nothing is pushed to `main` directly.

Branch naming: `feat/short-description` or `fix/short-description`

## Project Structure

```
src/
├── index.ts          # HTTP server entrypoint (Hono routes, middleware)
├── http-errors.ts    # Global HTTP error handler (AuthError, back-pressure, HTTPException → error body)
├── mcp.ts             # MCP protocol handling (routes shared by HTTP + stdio transports)
├── contracts.ts        # Zod schemas, shared types, ToolHandler interface, tool result helpers
├── db.ts               # SurrealDB connection factory, tenant-scoped KgDbClient
├── embed-registry.ts    # Embedding provider metadata (reads, requires, default model, dimensions, maxBatch)
├── embed.ts             # Embedding adapters (cohere | ollama | fixture) + boot dimension check
├── activation.ts         # Decay/activation scoring logic
├── session-prune.ts      # Background pruner for kg_auth_session rows (one per scoped signin)
├── secret-guard.ts       # Bearer-secret guard for operational endpoints
├── auth.ts                # JWT/scope validation, AuthError
├── auth-local.ts           # Local auth mode (KG_AUTH_MODE=local): the fixed identity and the boot warning
├── oauth.ts                 # OAuth 2.1 authorization server (DCR, PKCE, token issuance)
├── env.ts                    # Validated process env (`env`, `getEnv()`); schema lives in env-schema.ts
├── env-schema.ts              # Server env Zod schema + parseEnv (no process.env access)
├── env-embedding.ts           # Embedding env fragment (usable without the full server env)
├── env-auth.ts                 # Auth-mode env fragment (KG_AUTH_MODE, KG_LOCAL_SUB, KG_LOCAL_TENANT)
├── env-helpers.ts             # Shared Zod env field helpers (blank = unset, on/off flags)
├── metrics.ts                  # Request metrics
├── openapi.ts                   # REST API (/api/v1) routes + OpenAPI generation
├── rate-limit.ts                  # Rate limiting middleware
├── tools/
│   ├── index.ts       # Tool registry
│   ├── node-create.ts      # kg_node_create
│   ├── node-update.ts      # kg_node_update
│   ├── query.ts          # kg_query
│   ├── relate.ts            # kg_relate
│   ├── session-start.ts       # kg_session_start
│   ├── session-end.ts         # kg_session_end
│   ├── session-info.ts        # kg_session_info
│   ├── session-core.ts        # resolveActiveSession (shared by mcp.ts)
│   ├── default-container.ts   # ensureDefaultContainer: first-use provisioning, shared by node-create and project create
│   ├── meta-model.ts          # kg_meta_model: READS the stored meta_model rows (computed by a private batch job; see docs/meta-model.md)
│   └── status.ts               # kg_status
├── bin/
│   ├── kg.ts           # CLI entrypoint (auth / mcp subcommands)
│   ├── mcp.ts           # Local stdio MCP server
│   ├── stdio-claims.ts   # Who the CLI acts as: the local identity (local mode) or the `kg auth login` credentials
│   ├── auth.ts            # OAuth login CLI (browser + PKCE, credentials cached via keytar)
│   ├── reembed.ts           # Admin: re-embed nodes missing a vector or embedded by another model
│   └── reembed-work-list.ts # reembed's node selection (buildWorkList) and --limit parsing
├── benchmarks/         # Performance/drift/health benchmarks (see benchmarks/README.md)
└── test/               # Integration tests (*.integration.test.ts)

database/
└── migrations/       # 000_baseline.surql (full schema) + numbered changes, applied in filename order

scripts/
├── local-db.sh       # Local SurrealDB container (empty: run apply-migrations.sh next)
├── compose-migrate.sh # docker-compose `migrate` service: schema + migrations for the compose stack (SURREAL_USER/SURREAL_PASS from DB_ROOT_PASS)
├── compose-smoke.sh  # Boots the compose stack (fixture embeddings), asserts hardening + a second start; the CI `container` job
├── apply-migrations.sh # Apply database/migrations/*.surql to a fresh test database
├── schema-info.py    # A database's schema from INFO (no records, no JWT keys); --apply = runnable order
└── schema-diff.sh    # Compare two databases' schemas
```

## SurrealDB Patterns

### Record References

Bind IDs as query variables and use `type::record()`, not string interpolation:

```typescript
// Good
db.query(
  "SELECT id FROM type::record('node', $node_id) WHERE tenant = type::record('tenant', $tenant_id)",
  { node_id: nodeId, tenant_id: ctx.tenantId }
);

// Bad
db.query(`SELECT id FROM node:${nodeId}`); // SQL injection risk
```

### Session References

Sessions use SurrealDB-generated IDs, not sequential integers. `session_num` is display-only. Nodes reference sessions as record ID strings (e.g. `session:abc123`), resolved via `type::record('session', $session_id)` in queries, never by raw string concatenation.

### Query Patterns

```surql
-- Get nodes with decay, filtered by type
SELECT * FROM node 
WHERE type = $type AND decay_score > 0.1
ORDER BY decay_score DESC
LIMIT $limit

-- Vector similarity search
SELECT *, vector::similarity::cosine(embedding, $query_emb) AS score
FROM node
WHERE embedding != NONE
ORDER BY score DESC
LIMIT $limit
```

Batch related lookups into a single `db.query()` call (multiple statements, one round trip) instead of multiple sequential `await`s. See `getNeighborsWithWeightsBatch` in `tools/query.ts` for the pattern.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `KG_DB_URL` | *(required)* | SurrealDB WebSocket URL |
| `KG_DB_USER` | *(required)* | Database username |
| `KG_DB_PASS` | *(required)* | Database password |
| `KG_DB_NS` | `kg` | Namespace |
| `KG_DB_NAME` | `main` | Database name |
| `KG_JWT_SECRET` | *(required)* | Server's secret for the `kg_server` SurrealDB signin (min 32 chars). Despite the name it signs no JWT; its sha256 must be in `kg_config:signin` (see `docs/signin-secret.md`) |
| `EMBEDDING_PROVIDER` | `cohere` | `cohere` \| `ollama` \| `fixture`. One per install; switching on an existing database requires re-embedding (`bin/reembed.ts`; it refuses `fixture` without `--allow-fixture`), because vectors from different models are incompatible: until it finishes, queries compare vectors from both models |
| `EMBEDDING_API_KEY` | unset | Provider API key (required when the provider needs one, e.g. cohere) |
| `COHERE_API_KEY` | unset | Fallback for `EMBEDDING_API_KEY`, honoured only for cohere |
| `EMBEDDING_BASE_URL` | unset | Provider base URL. Required for `ollama` (`OLLAMA_URL` accepted as an alias, the generic name wins); optional for `cohere` (default `https://api.cohere.com/v1`, requests go to `<base>/embed`). Validated only when the selected provider reads it, so a stale `OLLAMA_URL` in a cohere deployment is ignored |
| `EMBEDDING_MODEL` | registry default | Provider model (ollama: `bge-m3`, must output 1024 dimensions, probed at boot for at most 60s; `OLLAMA_MODEL` accepted as an alias). Cohere's model is fixed; `fixture` ignores it |
| `KG_AUTH_MODE` | `komplyt` | `komplyt` verifies Komplyt-issued JWTs (hosted). `local` turns token checking off: every request is one fixed user in one fixed tenant, through the same `kg_server` signin and RLS. Boot logs a warning on every start. Securing the container is the operator's job (no Host/Origin checks, no bind restrictions). Never an admin. `local` together with `KOMPLYT_JWKS_URL` refuses to boot; any other value fails boot |
| `KG_LOCAL_SUB` | `local` | The fixed user in local mode (letters, digits, `_`, `-`; max 64) |
| `KG_LOCAL_TENANT` | `local` | The fixed tenant in local mode (same alphabet) |
| `KOMPLYT_JWKS_URL` | unset | JWKS endpoint for Komplyt auth (HTTP server; optional for CLI) |
| `KOMPLYT_ISSUER` | unset | Komplyt auth issuer (HTTP server; optional for CLI) |
| `KOMPLYT_AUDIENCE` | `kg-server` | Comma-separated accepted audiences |
| `KG_PUBLIC_URL` | unset | Public URL of the HTTP server (OAuth metadata) |
| `CORS_ORIGINS` | unset | Comma-separated allowed origins |
| `LISTEN_ADDR` | `0.0.0.0:3000` (`127.0.0.1:3000` in local auth mode when unset) | HTTP server bind address |
| `KG_LOCAL_ALLOWED_HOSTS` | unset | Local auth mode: extra accepted `Host` values besides loopback |
| `MCP_SERVER_NAME` | `komplyt-zero` | MCP server identity string |
| `TRUSTED_PROXY_CIDR` | unset | CIDR for trusted proxy (rate limiting) |
| `PURGE_JOB_SECRET` | unset | Shared secret for `/admin/purge` (min 32 chars; absent = endpoint disabled) |
| `KG_EMBED_FIXTURES` | `false` | Legacy alias for `EMBEDDING_PROVIDER=fixture`; combined with any other explicit `EMBEDDING_PROVIDER` it is a validation error |
| `KG_SESSION_PRUNE` | `true` | Run the `kg_auth_session` pruner (`false`/`no`/`off`/`0` disables it; blank = default) |
| `KG_SESSION_RETENTION_HOURS` | `24` | Session rows older than this are deleted; must exceed the longest-lived scoped connection |
| `KG_SESSION_PRUNE_INTERVAL_MINUTES` | `60` | How often the pruner runs |
| `METRICS_TOKEN` | unset | Bearer token (min 16 chars) required on `/metrics` and `/pool-metrics`; absent = open |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `LOG_PRETTY` | unset | `1`/`true`/`on` pretty-prints logs (needs the `pino-pretty` devDependency; `NODE_ENV=development` does the same). Default: JSON lines |
| `LOGTAIL_TOKEN` | unset | Better Stack log shipping (optional) |
| `DEV_SURFACE_ERRORS` | `false` | Surface real error details in JSON-RPC responses |
| `KG_REQUIRE_EE` | `false` | Refuse to start without `src/ee/` (set in hosted deploys) |

Schema: `src/env-schema.ts` (embedding part: `src/env-embedding.ts`, driven by `src/embed-registry.ts`). Template: `src/.env.example`.

## Deployment

Hosted deployments and the integration CI run from a private repository. A self-hosted deployment needs only the environment variables above; see `docs/self-hosting.md`.
