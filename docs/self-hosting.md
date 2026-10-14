# Self-hosting Zero

This guide gets the Zero HTTP server running against your own SurrealDB, with your own identity provider and, if you want, your own embedding model. It assumes you are comfortable with Docker, environment files and an OIDC issuer.

## What you need

- [Bun](https://bun.sh) 1.x. The server uses Bun's HTTP server, so Node will not run it.
- SurrealDB 3.x. CI runs against v3.2.4, which is what `scripts/local-db.sh` starts.
- An embedding provider: a Cohere API key, or Ollama with a 1024-dimension model.
- For more than one user: an OIDC issuer that publishes a JWKS and can add a custom `tenantId` claim to access tokens. If you are the only user, local auth mode (`KG_AUTH_MODE=local`) needs no issuer.

The issuer is the requirement people trip over, so it is explained first.

## Why the server needs an issuer

Zero never creates users or passwords. Every request carries a bearer JWT, and the server verifies it against the issuer's JWKS. It then uses the token's `tenantId` to sign in to SurrealDB as that tenant, so the database's own record permissions scope every read and write. Without a valid token there is no tenant, and without a tenant there is nothing to query.

Scopes are not an access-control layer yet. The OAuth metadata lists `kg:read` and `kg:write`, but the server adds both to every token that passes the checks below, because some OAuth clients cannot request custom scopes at consent time. Authorization rests on the verified issuer, audience and `tenantId`, not on `scope`. Do not rely on issuing a token without `kg:write` to make it read-only.

The server checks these claims:

| Claim | Required | Meaning |
|-------|----------|---------|
| `iss` | Yes | Must equal `KOMPLYT_ISSUER` |
| `aud` | Yes | Must be one of `KOMPLYT_AUDIENCE` (default `kg-server`) |
| `sub` (or `azp`) | Yes | The user, or the client for machine-to-machine tokens |
| `tenantId` | Yes | Any stable string. The tenant is created on the first `kg_session_start` |
| `projects` | No | Project ids the user may see. Empty or absent means all projects in the tenant |
| `platformRole` | No | `admin` unlocks the admin routes in `src/ee/`; anything else is treated as `member` |

A single person can use one fixed `tenantId`. A team that should share a graph uses the same `tenantId` for everyone. Keycloak (a hardcoded-claim or user-attribute mapper), Zitadel (an action), Authentik (a property mapping) and Auth0 (a post-login action) can all add the claim.

If you are the only user, you can skip the issuer: set `KG_AUTH_MODE=local` and the server stops checking tokens. Every request is then one fixed user (`KG_LOCAL_SUB`, default `local`) in one fixed tenant (`KG_LOCAL_TENANT`, default `local`), through the same `kg_server` sign-in and row-level security as a verified token. It is never a platform admin, it logs a warning on every start, and it refuses to start if `KOMPLYT_JWKS_URL` or `KOMPLYT_ISSUER` is set (comment them out of your `.env`). The first use creates a default container called "Company Knowledge".

Because there is no token, local mode is for a machine only you can reach. The server listens on `127.0.0.1:3000` when `LISTEN_ADDR` is unset and warns when you bind to anything else. It rejects a request with a foreign `Origin` (anything not in `CORS_ORIGINS`), a `Host` that is not loopback (add names in `KG_LOCAL_ALLOWED_HOSTS`, for example behind a reverse proxy), or a `POST`, `PUT` or `PATCH` body that is not `application/json`. Those checks stop a web page open in your browser from driving the server. They do not make it safe to expose to a network.

## 1. Start SurrealDB

For a local trial:

```bash
cd src
../scripts/local-db.sh up
```

The script starts `surrealdb/surrealdb:v3.2.4` on `127.0.0.1:8000` with `root`/`root`, creates the `kg` namespace and a database (`local` unless you set `KG_DB_NAME`), and prints the `KG_DB_*` lines for your `.env`. Data lives in memory unless you set `KG_LOCAL_PERSIST=1`. `../scripts/local-db.sh down` removes the container. Override the image with `SURREAL_IMAGE`.

For anything you intend to keep, run SurrealDB the way you run your other databases, with persistent storage and backups.

## 2. Apply the schema

The schema is defined only by the migrations in `database/migrations/`. Apply every file in filename order, with whatever tool you prefer. With curl against the local instance:

```bash
for f in ../database/migrations/*.surql; do
  curl -s -X POST http://127.0.0.1:8000/sql -u root:root -H "Accept: application/json" \
    -H "surreal-ns: kg" -H "surreal-db: local" --data-binary @"$f" > /dev/null
done
```

Apply new migrations the same way when you upgrade. They are written to be applied once each, in order.

## 3. Configure

```bash
cp .env.example .env
```

Fill in the database values printed by `local-db.sh`, a random `KG_JWT_SECRET` of at least 32 characters, your issuer's `KOMPLYT_ISSUER` and `KOMPLYT_JWKS_URL`, and your embedding provider. `KG_JWT_SECRET` is not used to sign user tokens. It authenticates the server's tenant-scoped sign-in to SurrealDB, and on first boot the server stores its hash in the database so that only this server can sign in that way. A server whose secret is not on that list refuses to start, so to rotate the secret, add the new hash first; the procedure is in [signin-secret.md](signin-secret.md).

For local embeddings:

```bash
EMBEDDING_PROVIDER=ollama
EMBEDDING_BASE_URL=http://localhost:11434
EMBEDDING_MODEL=bge-m3
```

`OLLAMA_URL` and `OLLAMA_MODEL` are accepted as aliases. No Cohere key is needed. The vector index has 1024 dimensions; at boot the server probes Ollama with one embedding (up to 60 seconds, so a cold container can come up) and refuses to start if the model does not produce 1024 dimensions. Use one provider per install: switching later means re-embedding with `bun run bin/reembed.ts`.

## 4. Run

```bash
bun index.ts
```

`GET /health` answers once the server is up and `GET /ready` once it can reach the database. Point your MCP client at `http://<host>:3000/mcp` with a bearer token from your issuer. For Claude Code:

```bash
claude mcp add --transport http zero http://localhost:3000/mcp \
  --header "Authorization: Bearer $ZERO_TOKEN"
```

Tokens expire, so for daily use put the server behind something that refreshes them, or use a client that speaks OAuth to your issuer.

## Running without `src/ee/`

The code in `src/ee/` is under the Elastic License 2.0 (see the [README](../README.md#licence)). If you remove the folder, the server logs that it is running the open-source edition and leaves out the OAuth discovery endpoints, the container management API under `/api/v1/containers` and the admin routes. All MCP tools and the rest of the REST API keep working. Set `KG_REQUIRE_EE=true` if you want a missing `src/ee/` to stop the server instead.

`src/Dockerfile` copies `src/ee/`, so a container build without it needs that line removed.

## The stdio server

`kg mcp` (`src/bin/mcp.ts`) is a stdio MCP server that talks to SurrealDB directly and reads the same `EMBEDDING_*` settings as the HTTP server. With `KG_AUTH_MODE=local` it skips `kg auth login` and acts as the same fixed local user as the HTTP server. Without it, it expects credentials from the hosted service's login flow, which is not a self-hosting route.

## Known gaps

These are the rough edges a self-hoster will meet, listed so you can plan around them:

- Local auth mode is single-user. For several people sharing a graph you need an issuer (see above).
- Ollama needs a 1024-dimension model.
- There is no export command yet. Your data is in SurrealDB tables (`node`, `edge`, `project`, `session`) and can be exported with SurrealDB's own tools.
