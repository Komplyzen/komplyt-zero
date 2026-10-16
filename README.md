# Komplyt Zero

An open-source memory graph for your AI tools. Run it yourself, or use ours in the EU.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/Komplyzen/komplyt-zero/actions/workflows/ci.yml/badge.svg)](https://github.com/Komplyzen/komplyt-zero/actions/workflows/ci.yml)

Agents lose the reasoning behind a decision when the session ends, and each client keeps separate notes. Zero is an MCP server that gives Claude, ChatGPT, Cursor and any other MCP client one shared memory. Agents record decisions, problems and approaches together with the reason, as typed nodes in a graph. A later session, in any client, finds them by meaning instead of keyword, so the reasoning behind last month's choice is there when someone is about to undo it. It is for developers who use several AI clients on the same product, and for teams that keep re-deciding things because nobody remembers why.

A notes file grows until nobody reads it, and a plain vector store returns the closest text with nothing around it. Zero keeps the reason with each decision, links related nodes so a hit brings its context along, and lets knowledge nobody uses drop down the ranking. Nothing is deleted. It stores what the agent was asked to keep, not your chats.

The engine is Apache-2.0. The team features in `src/ee/` are source-available under the Elastic License 2.0, and Zero runs on SurrealDB (Business Source License), so the stack as a whole is not OSI open source. Details are in [Licence](#licence).

To try the hosted service (free for one person, data stored in Frankfurt), add it to Claude Code and run `/mcp` to sign in. To run it on your own machine, see [Getting started](#getting-started).

```bash
claude mcp add --transport http komplyt-zero https://kg.kompl.yt/mcp
```

## What it looks like

An agent working on a webhook service records a decision:

```json
{
  "tool": "kg_node_create",
  "arguments": {
    "type": "decision",
    "project": "acme-api",
    "tags": ["architecture", "webhooks"],
    "content": "Webhook delivery uses a Postgres job table (SKIP LOCKED) instead of Redis or SQS. Why: under 1k jobs/min, Postgres already runs, and enqueueing in the same transaction as the business write means no lost events. Revisit above 10k jobs/min."
  }
}
```

Three weeks later, in a different client, someone asks a question that shares no keywords with it:

```json
{
  "tool": "kg_query",
  "arguments": { "text": "why don't we use Redis for background jobs?", "project": "acme-api" }
}
```

The decision comes back first. Spreading activation also returns the nodes linked to it, such as the open problem about retry storms that someone related to it last week.

## How it ranks what comes back

Every node carries an embedding and a decay score. A query ranks candidates by `0.7 × cosine similarity + 0.3 × decay score`, then follows the graph's edges for up to three hops (two by default) to pull in related nodes, each hop weakening the signal by half.

The decay score is how the graph forgets. Each time a session starts in a project, every node in that project loses 15 % of its score. Nodes that agents query or update get some of it back, more when they sit in a dense neighbourhood. Knowledge that keeps being used stays near the top, and knowledge nobody touches fades without anyone having to curate it. Decay never deletes anything; a faded node still turns up when a query matches it closely enough.

The graph, the decay and the spreading activation are all in this repository under Apache-2.0. The hosted service runs the same ranking code.

## Getting started

**Use the hosted service.** This is the fastest route and needs no infrastructure. Add `https://kg.kompl.yt/mcp` as a custom connector in Claude or ChatGPT, or in Claude Code (the command is at the top of this page).

In Claude Code, run `/mcp` afterwards to sign in. Data is stored in Frankfurt. Step-by-step instructions for each client are in [docs/connectors.md](docs/connectors.md).

**Run it yourself, with Docker.** The compose file starts SurrealDB, Ollama embeddings and the server with one command. It needs Docker with the Compose plugin: `docker compose version` should print a version. Debian's `docker.io` package lacks it, so install `docker-compose` (Ubuntu: `docker-compose-v2`) or Docker's own packages.

```bash
git clone https://github.com/Komplyzen/komplyt-zero.git
cd komplyt-zero
KG_JWT_SECRET=$(openssl rand -hex 32) docker compose up --build
claude mcp add --transport http zero http://localhost:3000/mcp
```

The first start downloads the embedding model (`bge-m3`, about 1.2 GB). The server runs in **local auth mode** (`KG_AUTH_MODE=local`): no tokens, one fixed user in one fixed tenant, and a default container called "Company Knowledge" created on first use. That suits one person on one machine, so compose publishes the port on `127.0.0.1` only. Don't publish the port beyond localhost, or put a proxy in front of it, unless the proxy authenticates callers.

**Run it yourself, without Docker for the server.** Zero needs [Bun](https://bun.sh), a SurrealDB instance and an embedding provider:

```bash
git clone https://github.com/Komplyzen/komplyt-zero.git
cd komplyt-zero/src
bun install
../scripts/local-db.sh up        # SurrealDB v3.2.4 in Docker, prints the KG_DB_* values
# apply database/migrations/*.surql in filename order (see docs/self-hosting.md)
cp .env.example .env             # fill in the values. For single-user use: set KG_AUTH_MODE=local and
                                 # comment out KOMPLYT_JWKS_URL and KOMPLYT_ISSUER (local mode refuses to start with them)
bun index.ts
```

In local mode (`KG_AUTH_MODE=local`) you need no identity provider: the server listens on `127.0.0.1:3000` unless you set `LISTEN_ADDR`, and rejects browser requests from other origins, other `Host` values (`KG_LOCAL_ALLOWED_HOSTS` adds some) and non-JSON bodies.

For a team or a public deployment, keep the default mode: the server accepts bearer JWTs from an OIDC issuer you point it at (Keycloak, Zitadel, Authentik, or anything that publishes a JWKS and can add a custom claim), and every token needs a `tenantId` claim, which scopes each query to one tenant. The modes can't be combined: local mode refuses to start when `KOMPLYT_JWKS_URL` or `KOMPLYT_ISSUER` is set. [docs/self-hosting.md](docs/self-hosting.md) covers the full setup and the claims the server expects.

**Use it from npm, as a stdio server.** With your own SurrealDB and embedding provider, `npx @komplyzen/komplyt-zero mcp` starts Zero as a stdio MCP server for your client. It reads the same `KG_DB_*` and `EMBEDDING_*` settings, and `KG_AUTH_MODE=local` skips the login. On Linux it needs `libsecret` (Debian and Ubuntu: `sudo apt install libsecret-1-0`), because its credential store is a native module; without it the command fails at start with `ERR_DLOPEN_FAILED`. For a first try, Docker is simpler, since it brings SurrealDB and Ollama along.

## Using it well

The server tells every client how to use it, but a few habits separate a graph that answers questions from a pile of notes. Query before you record, because the server doesn't deduplicate. Put the reason in the content, since only the content is embedded. Start each session with the right `project`, because decay and filtering key on it. At the end, re-activate the nodes you relied on so they stay findable.

[docs/using-zero.md](docs/using-zero.md) collects what we learned running Zero on our own work since early 2026: what to record and what to leave out, how to replace a decision without losing its history, which queries retrieve badly, and the end-of-session routine we use. Ready-to-copy agent instructions and a session-close skill are in [examples/](examples/).

## Tools

| Tool | What it does |
|------|--------------|
| `kg_session_start` | Starts a session in a project and applies decay to that project's nodes |
| `kg_session_end` | Ends the current session |
| `kg_session_info` | Shows the current session and node counts (read-only) |
| `kg_status` | Lists open problems and todos, and recent decisions and approaches (read-only) |
| `kg_node_create` | Records an observation, decision, argument, todo, problem, mitigation, workaround or approach |
| `kg_node_update` | Changes a node's status or content, and re-activates it |
| `kg_query` | Semantic search with type, status and project filters, plus spreading activation |
| `kg_relate` | Creates an edge between two nodes, or strengthens an existing one |
| `kg_meta_model` | Reads the stored methodology, resiliency or process model of a container, project or person (read-only; computed ahead of time, see [docs/meta-model.md](docs/meta-model.md)) |

Only `kg_node_update` changes what a node says. Querying, relating and starting sessions change usage scores, which shape future rankings. Pass `read_only: true` to `kg_query` when you are only looking, for example from a dashboard. The same operations are available over REST under `/api/v1`, described by `/api/v1/openapi.json`. Full parameter schemas are in `src/contracts.ts`. If you used the tools under their earlier names, see [docs/migration-tool-split.md](docs/migration-tool-split.md).

## Embeddings

Zero uses Cohere's `embed-multilingual-v3.0` by default. Ollama works for fully local embeddings, with one constraint: the vector index has 1024 dimensions, so the model must produce 1024-dimension vectors (`bge-m3` and `mxbai-embed-large` do; Ollama's default `nomic-embed-text` does not). The server checks the dimension at boot and refuses to start on a mismatch.

```bash
EMBEDDING_PROVIDER=ollama
EMBEDDING_BASE_URL=http://localhost:11434   # OLLAMA_URL is accepted as an alias
EMBEDDING_MODEL=bge-m3                      # optional; OLLAMA_MODEL is accepted as an alias
```

Run one provider per install: every stored vector must come from the same model. Switching provider or model on an existing database needs `bun run bin/reembed.ts` (use `--dry-run` first); until it finishes, queries compare against vectors from both models and results from nodes not yet re-embedded are unreliable. Cohere takes `EMBEDDING_API_KEY` (`COHERE_API_KEY` is still accepted). `EMBEDDING_PROVIDER=fixture` gives deterministic vectors without network calls, which is what the tests use. To add a provider, write an `EmbeddingAdapter` in `src/embed.ts`, list it in `ADAPTER_FACTORIES` and add its metadata to `src/embed-registry.ts`; env validation then accepts the new name with no other change.

## Configuration

The variables you need for a first run are below; `src/.env.example` lists the rest.

| Variable | Required | Description |
|----------|----------|-------------|
| `KG_DB_URL`, `KG_DB_USER`, `KG_DB_PASS` | Yes | SurrealDB connection |
| `KG_DB_NS`, `KG_DB_NAME` | No | Namespace and database (default `kg` / `main`) |
| `KG_JWT_SECRET` | Yes | At least 32 characters. Used for the tenant-scoped SurrealDB sign-in, not for signing user tokens |
| `KG_AUTH_MODE` | No | `komplyt` (default) verifies tokens from your OIDC issuer; `local` turns token checking off for single-user use |
| `KOMPLYT_JWKS_URL`, `KOMPLYT_ISSUER` | Yes in `komplyt` mode (HTTP) | The OIDC issuer whose tokens the server accepts. Not allowed in `local` mode |
| `KOMPLYT_AUDIENCE` | No | Accepted token audiences, comma-separated (default `kg-server`) |
| `EMBEDDING_PROVIDER` | No | `cohere` (default), `ollama` or `fixture` |
| `EMBEDDING_API_KEY` | For cohere | Provider API key (`COHERE_API_KEY` is accepted for cohere) |
| `EMBEDDING_BASE_URL` | For ollama | Provider base URL (`OLLAMA_URL` is accepted for ollama) |
| `EMBEDDING_MODEL` | No | Provider model (default from the registry; `OLLAMA_MODEL` is accepted for ollama) |
| `LISTEN_ADDR` | No | Bind address (default `0.0.0.0:3000`; `127.0.0.1:3000` in local mode when unset) |

## Open source and the hosted product

This repository is the engine. In local auth mode, or once it has an OIDC issuer to trust, it is a complete memory for one person, which you run yourself, record into and query from any MCP client.

Working as a team is the paid part. The engine enforces who may read which container of nodes, but the code that sets up team work lives in `src/ee/` and belongs to Komplyt Teams: the API that creates shared containers and grants colleagues access to them, the OAuth integration for the Claude and ChatGPT connector directories, and the admin surface. Komplyzen also runs the engine as a hosted service: Komplyt Zero is free for one person, Personal raises the limits for heavier individual use, and Teams is priced per seat. Above that sits the Komplyt Platform, a separate, closed product that runs expert-authored workflows against the graph. Current tiers and prices are on [kompl.yt/zero](https://kompl.yt/zero), and questions about Teams or the Platform go to hello@kompl.yt.

## Licence

The engine is licensed under [Apache-2.0](LICENSE) (see [LICENSING.md](LICENSING.md) for the split). The code in `src/ee/` (OAuth discovery metadata for connector directories, the REST API for managing shared containers, and the admin and purge routes) is not part of the Apache-2.0 engine and is not covered by that licence. It is source-available under the [Elastic License 2.0](src/ee/LICENSE), and only those terms apply to it, although the Docker image contains it. The server runs without `src/ee/`; it then logs that it is the open-source edition and leaves those routes out.

Zero stores its data in [SurrealDB](https://surrealdb.com), which is licensed under the Business Source License 1.1. Self-hosting SurrealDB for your own use is permitted under that licence, but because of it the stack as a whole is not OSI open source, and we don't describe it as such.

## Contributing and security

Contributions are welcome; [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup, the test database and what a pull request needs. Report vulnerabilities privately to security@kompl.yt, as described in [SECURITY.md](SECURITY.md).

Zero is built by [Komplyzen GmbH](https://kompl.yt) in Berlin.
