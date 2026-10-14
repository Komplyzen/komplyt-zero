# Komplyt Zero

An open-source memory graph for your AI tools. Run it yourself, or use ours in the EU.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/Komplyzen/komplyt-zero/actions/workflows/ci.yml/badge.svg)](https://github.com/Komplyzen/komplyt-zero/actions/workflows/ci.yml)

Zero is an MCP server that gives Claude, ChatGPT, Cursor and any other MCP client one memory they share. Your agents write down what was decided, found or tried, together with the reason, as typed nodes in a graph. A later session, in the same tool or a different one, finds those nodes by meaning instead of by keyword, so the reasoning behind last month's choice is there when someone is about to undo it.

Zero does not store your chats. It stores what the agent was asked to keep, which in practice means decisions, problems, observations and approaches, each with the reason that makes it worth keeping.

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

The decision comes back first. Spreading activation also returns the nodes linked to it, such as the open problem about retry storms that someone related to it last week, so the agent sees the decision in its context rather than as an isolated fact.

## How it ranks what comes back

Every node carries an embedding and a decay score. A query ranks candidates by `0.7 × cosine similarity + 0.3 × decay score`, then follows the graph's edges for up to three hops (two by default) to pull in related nodes, each hop weakening the signal by half.

The decay score is how the graph forgets. Each time a session starts in a project, every node in that project loses 15 % of its score. Nodes that agents query or update get some of it back, more when they sit in a dense neighbourhood. Knowledge that keeps being used stays near the top, and knowledge nobody touches fades without anyone having to curate it. Decay never deletes anything; a faded node still turns up when a query matches it closely enough.

The graph, the decay and the spreading activation are all in this repository under Apache-2.0. The hosted service runs the same ranking code.

## Getting started

**Use the hosted service.** This is the fastest route and needs no infrastructure. Add `https://kg.kompl.yt/mcp` as a custom connector in Claude or ChatGPT, or in Claude Code:

```bash
claude mcp add --transport http komplyt-zero https://kg.kompl.yt/mcp
```

Then run `/mcp` inside Claude Code to sign in. Data is stored in Frankfurt. Step-by-step instructions for each client are in [docs/connectors.md](docs/connectors.md).

**Run it yourself, with Docker.** The quickest route is the compose file: SurrealDB, Ollama embeddings and the server in one command. It needs Docker with the Compose plugin (`docker compose version` should print a version; on Debian the `docker.io` package does not include it, install `docker-compose` (Ubuntu: `docker-compose-v2`) or use Docker's own packages).

```bash
git clone https://github.com/Komplyzen/komplyt-zero.git
cd komplyt-zero
KG_JWT_SECRET=$(openssl rand -hex 32) docker compose up --build
claude mcp add --transport http zero http://localhost:3000/mcp
```

The first start downloads the embedding model (`bge-m3`, roughly 1.2 GB). The server runs in **local auth mode** (`KG_AUTH_MODE=local`): no tokens, every request is one fixed user in one fixed tenant, and the first use creates a default container called "Company Knowledge". That is built for one person on one machine, so the compose file publishes the port on `127.0.0.1` only. Do not publish it further, or put a proxy in front of it, unless something in front authenticates callers.

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

There are two ways to handle identity. With `KG_AUTH_MODE=local` you need no identity provider. The server also listens on `127.0.0.1:3000` unless you set `LISTEN_ADDR`, and it rejects browser requests from other origins, other `Host` values (`KG_LOCAL_ALLOWED_HOSTS` adds some) and non-JSON bodies. For a team or a public deployment, leave the mode at its default: the server then accepts bearer JWTs from an OIDC issuer you point it at, and every token needs a `tenantId` claim, which is what scopes each query to one tenant. Keycloak, Zitadel, Authentik or any other issuer that publishes a JWKS and lets you add a custom claim will do. The two modes cannot be combined: local mode refuses to start when `KOMPLYT_JWKS_URL` or `KOMPLYT_ISSUER` is set. [docs/self-hosting.md](docs/self-hosting.md) walks through the whole setup, including the claims the server expects.

## Using it well

The server tells every client how to use it, but a few habits make the difference between a graph that answers questions and a pile of notes. Query before you record, because the server does not deduplicate. Put the reason in the content, since the content is the only thing that gets embedded. Start each session with the right `project`, because decay and filtering both key on it. At the end of a session, re-activate the nodes you relied on so they stay findable.

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

The engine is licensed under [Apache-2.0](LICENSE) (see [LICENSING.md](LICENSING.md) for the split). The code in `src/ee/` (OAuth discovery metadata for connector directories, the REST API for managing shared containers, and the admin and purge routes) is source-available under the [Elastic License 2.0](src/ee/LICENSE), which lets you use, modify and self-host it for your own organisation (there is no licence key) but forbids offering it to others as a hosted or managed service. The server runs without `src/ee/`; it then logs that it is the open-source edition and leaves those routes out.

Zero stores its data in [SurrealDB](https://surrealdb.com), which is licensed under the Business Source License 1.1. Self-hosting SurrealDB for your own use is permitted under that licence, but because of it the stack as a whole is not OSI open source, and we don't describe it as such.

## Contributing and security

Contributions are welcome; [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup, the test database and what a pull request needs. Report vulnerabilities privately to security@kompl.yt, as described in [SECURITY.md](SECURITY.md).

Zero is built by [Komplyzen GmbH](https://kompl.yt) in Berlin.
