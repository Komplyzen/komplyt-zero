/**
 * Vitest setup: complete the env so the standard modules load.
 *
 * src/env.ts validates the full server env eagerly on import and src/db.ts
 * (the standard connection factory) imports it. CI provides real values via
 * job env; locally, missing values fall back to the docker-compose instance
 * (ws://localhost:8000, root/root — see scripts/local-db.sh) plus an inert
 * JWT secret. Fixture embeddings need no API key.
 * Anything already present in the environment always wins.
 *
 * Embeddings default to the fixture provider through EMBEDDING_PROVIDER, not
 * the legacy KG_EMBED_FIXTURES switch: forcing KG_EMBED_FIXTURES=true would
 * conflict with an EMBEDDING_PROVIDER from a developer shell or .env. The
 * fixture provider reads no other embedding setting, so a stray EMBEDDING_MODEL
 * is ignored. CI jobs that still set KG_EMBED_FIXTURES=true get
 * fixture + fixture, which is valid.
 */

process.env.KG_DB_URL ??= 'ws://localhost:8000';
process.env.KG_DB_USER ??= 'root';
process.env.KG_DB_PASS ??= 'root';
process.env.KG_DB_NS ??= 'kg';
process.env.KG_DB_NAME ??= 'test';
process.env.KG_JWT_SECRET ??= 'test-jwt-secret-32-characters-min!!';
process.env.EMBEDDING_PROVIDER ??= 'fixture';
