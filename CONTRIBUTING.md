# Contributing to Komplyt Zero

Thanks for taking the time. Bug reports, fixes, documentation and new embedding providers are all welcome. For anything larger than a fix, open an issue first so we can agree on the approach before you spend time on it.

## Development setup

You need [Bun](https://bun.sh) and Docker. The server runs on Bun; the `tsx` scripts in `package.json` are only used by the benchmarks.

```bash
git clone https://github.com/Komplyzen/komplyt-zero.git
cd komplyt-zero/src
bun install

# Unit tests: no database, deterministic fixture embeddings
EMBEDDING_PROVIDER=fixture bun run test:run

bun run typecheck
```

## Secret scanning

CI scans every pull request with [gitleaks](https://github.com/gitleaks/gitleaks) and `.gitleaks.toml`. To catch a leak before it is committed, install gitleaks and enable the pre-commit hook once per clone:

```bash
git config core.hooksPath scripts/hooks
```

Never commit real keys, passwords or database hostnames, not even in tests or docs; use placeholders such as `your-api-key`. If the scanner flags a documented placeholder, extend the allowlist in `.gitleaks.toml` and add a probe to `src/gitleaks-config.test.ts`.

## Integration tests

Integration tests (`src/test/*.integration.test.ts`) run against a real SurrealDB, because the database is most of what Zero does. They never define schema themselves. The only source of schema is `database/migrations/`, so start an empty database and apply the migrations to it:

```bash
KG_DB_NAME=test ../scripts/local-db.sh up
SURREAL_HTTP=http://127.0.0.1:8000 KG_DB_NAME=test ../scripts/apply-migrations.sh

KG_DB_URL=ws://127.0.0.1:8000 KG_DB_USER=root KG_DB_PASS=root KG_DB_NS=kg KG_DB_NAME=test \
  KG_JWT_SECRET=local-test-secret-at-least-32-chars \
  EMBEDDING_PROVIDER=fixture KG_REQUIRE_DB=1 bun run test:run test/
```

The tests refuse to run against a database named `main`. With `KG_REQUIRE_DB=1`, a missing database fails the run instead of skipping the integration suites, which is how CI runs them. A single file runs with `bun run test:run auth.test.ts`. Schema comes only from `database/migrations/`: never define schema inside a test. To change the schema, add the next numbered file there (never edit `000_baseline.surql`); see "Changing the schema" in `CLAUDE.md`.

## Adding an embedding provider

One adapter plus one registry entry: metadata (settings read and required, default model, dimensions or `'probe'`, `maxBatch`) in `src/embed-registry.ts`, and the `EmbeddingAdapter` in `src/embed.ts` listed in `ADAPTER_FACTORIES`. Configuration uses the generic `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL`; env validation needs no change. Switching an existing database to another provider or model needs `bun run bin/reembed.ts` (vectors from different models are not comparable; until it finishes, queries mix both). reembed refuses the fixture provider without `--allow-fixture`.

## Pull requests

1. Fork the repository and create a branch named `feat/<short-description>` or `fix/<short-description>`.
2. Make the change, with tests. New behaviour needs a test that exercises it through the tools or the database, not a mock of them.
3. Run `bun run typecheck` and the tests.
4. Open a pull request that says what changed and why.

CI runs type checking, unit tests and a dependency audit on every pull request, including those from forks. Integration tests need database credentials, so for pull requests from forks a maintainer starts them after reviewing the code.

### Dependency updates (maintainers)

Dependabot opens at most two pull requests per ecosystem a month (GitHub Actions, Docker, Compose). Its pull requests run the public CI only. The private integration run needs a secret that Dependabot runs do not receive, and it should not: a new base image, action or package is unreviewed upstream content that would run next to the staging database. So `integration-tests` stays pending, and merging is blocked, until a maintainer has read the diff and comments `/ok-to-test <sha>` with the commit they reviewed. A push after that invalidates the approval, as for forks. Major versions of `oven/bun` and `surrealdb/surrealdb` are ignored: those upgrades are deliberate.

### Releasing (maintainers)

A release is a `v*` tag. `.github/workflows/release.yml` then publishes `@komplyzen/komplyt-zero` to npm (trusted publishing, no token, with provenance), the server entry to the MCP Registry, and a multi-arch image to `ghcr.io/komplyzen/komplyt-zero`. To release: bump `version` in `src/package.json` and, in three places, `server.json` (`version` and `packages[0].version`), merge that through a normal pull request, then tag the merged commit. The workflow refuses a tag that disagrees with those files or is not on `main`, and a prerelease tag (`v1.1.0-rc.1`) goes to the `next` npm tag and does not move the image's `latest`. Only maintainers can push `v*` tags. A pull request that touches the release files runs the same checks, including `npm publish --dry-run` and an unpushed image build.

First-time setup, once: publish a throwaway version by hand (`cd src && npm pkg set version=0.0.1 && npm publish --access public --tag bootstrap`, then `git checkout package.json`), add the trusted publisher on npmjs.com (organisation `Komplyzen`, repository `komplyt-zero`, workflow `release.yml`), and set the `komplyt-zero` package on ghcr.io to public after the first image push.

[CLAUDE.md](CLAUDE.md) describes the architecture and the coding conventions in more detail. It is written for AI coding agents, and it is just as useful for people.

## Where code goes

New features belong in the Apache-2.0 core unless they extend what `src/ee/` already covers (OAuth discovery, the container management API, admin routes). If you are unsure, ask in the issue first.

## Questions

Open an [issue](https://github.com/Komplyzen/komplyt-zero/issues) for bug reports and ideas, which keeps them searchable. For quick questions and informal discussion, join us on [Discord](https://discord.gg/y2X32ddCc). Security problems go to security@kompl.yt instead; see [SECURITY.md](SECURITY.md).
