# Integration Tests TODO

These integration tests verify behavior against a real SurrealDB instance. Unit tests (41 passing) cover pure functions and schema validation. Integration tests require a running database.

## Required Tests

### db.ts
- [ ] `createScoped` connects and injects claims
- [ ] `createScoped` fails gracefully on connection error
- [ ] `createScoped` fails gracefully on auth error
- [ ] `query` flattens multi-statement results
- [ ] `queryOne` returns null for empty results

### activation.ts
- [ ] `getNeighborhoodStats` returns correct 2-hop counts
- [ ] `activateNode` updates decay_score and logs event
- [ ] `applySessionDecay` decays nodes in project scope
- [ ] `implicitActivateBatch` updates multiple nodes atomically
- [ ] `logDecayEvent` creates audit record

### embed.ts (Cohere)
- [ ] cohere provider (`createEmbeddingProvider('cohere', ...)`) returns 1024-dim vectors
- [ ] cohere provider times out after 30s
- [ ] cohere provider throws on API error

## Setup Requirements

- SurrealDB running locally or via testcontainer
- `KG_TEST_*` env vars configured
- Cohere API key for embedding tests (or mock server)
