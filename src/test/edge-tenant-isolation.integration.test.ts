/**
 * Integration tests for Edge TYPE RELATION tenant isolation
 *
 * Tests verify:
 * 1. Tenant A cannot RELATE to tenant B nodes (RLS on CREATE)
 * 2. Arrow traversal respects node-level tenant RLS
 * 3. Edge metadata (weight, type) is accessible via arrow syntax
 * 4. (LYT-264) What tenant A can read from the `edge` table itself. `edge` keeps
 *    `FOR select FULL`, so the direct-read and edge-by-start-id tests are
 *    `it.fails`: they document the accepted exposure and go red when the select
 *    is scoped (see the DECISION comment further down and CLAUDE.md).
 *
 * Run with: bun run vitest run edge-tenant-isolation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { EMBEDDING_DIMENSIONS, EmbeddingProvider, KgDbClient } from '../contracts.js';
import { dbFactory } from '../db.js';
import { getNeighborsWithWeightsBatch, queryTool } from '../tools/query.js';
import { connectTestDb, wipeData } from './connect.js';

let rootDb: Surreal;

// Text-only query path: no embeddings are needed to seed spread activation.
const noopEmbed: EmbeddingProvider = {
  embedDocuments: async (texts: string[]) => texts.map(() => []),
  embedQuery: async () => [],
  model: 'test-mock',
  dimensions: EMBEDDING_DIMENSIONS,
};

/**
 * Tenant-scoped client via the standard factory — signs in against the real
 * `kg_server` access (migration 006) so RLS applies via $auth.
 */
async function createTenantSession(tenantId: string, userId: string): Promise<KgDbClient> {
  return dbFactory.createScoped({
    sub: userId,
    tenantId,
    scope: 'kg:read kg:write',
    principals: [`principal:user_${userId}`, `principal:tenant_${tenantId}`],
    projects: [],
    tier: 'free',
  });
}

describe('Edge TYPE RELATION Tenant Isolation', () => {
  let skipTests = false;

  // Runtime skip: a skipped test must REPORT as skipped. The old
  // `if (skipTests) return` pattern counted empty test bodies as PASSED
  // (weeks of green CI over zero assertions).
  beforeEach((ctx) => {
    if (skipTests) ctx.skip();
  });

  beforeAll(async () => {
    const conn = await connectTestDb();
    if (!conn) {
      skipTests = true;
      return;
    }
    rootDb = conn;
    await wipeData(rootDb);

    // Create test tenants, sessions, and nodes as root.
    // Real node schema requires content, source, session_created,
    // session_activated; type must pass the schema ASSERT.
    await rootDb.query(`
      CREATE tenant:tenant_a SET name = 'Tenant A';
      CREATE tenant:tenant_b SET name = 'Tenant B';
      CREATE session:sess_a SET tenant = tenant:tenant_a;
      CREATE session:sess_b SET tenant = tenant:tenant_b;
      CREATE node:node_a1 SET content = 'Node A1', source = 'test', tenant = tenant:tenant_a, type = 'observation', session_created = session:sess_a, session_activated = session:sess_a;
      CREATE node:node_a2 SET content = 'Node A2', source = 'test', tenant = tenant:tenant_a, type = 'decision', session_created = session:sess_a, session_activated = session:sess_a;
      CREATE node:node_b1 SET content = 'Node B1', source = 'test', tenant = tenant:tenant_b, type = 'observation', session_created = session:sess_b, session_activated = session:sess_b;
      CREATE node:node_b2 SET content = 'Node B2', source = 'test', tenant = tenant:tenant_b, type = 'decision', session_created = session:sess_b, session_activated = session:sess_b;
    `);

    // Container fixture (LYT-264): B's container, plus an A container nobody in
    // tenant A is granted on. node_b3/node_b4 live in B's container so direct
    // reads can filter edges by `in.container`.
    await rootDb.query(`
      CREATE container:ct_b SET name = 'B container', tenant = tenant:tenant_b, owner = principal:tenant_tenant_b, granted_principals = [principal:tenant_tenant_b];
      CREATE node:node_b3 SET content = 'Node B3', source = 'test', tenant = tenant:tenant_b, container = container:ct_b, type = 'observation', session_created = session:sess_b, session_activated = session:sess_b;
      CREATE node:node_b4 SET content = 'Node B4', source = 'test', tenant = tenant:tenant_b, container = container:ct_b, type = 'observation', session_created = session:sess_b, session_activated = session:sess_b;
    `);

    // Create edges as root (bypassing RLS). Explicit ids so tests can select by id.
    // B's edges carry a weight/type pair that no tenant A edge has, so a leak of
    // edge metadata is distinguishable from a leak of just the id.
    await rootDb.query(`
      RELATE node:node_a1->edge:edge_a_intra->node:node_a2 SET weight = 0.8, type = 'explicit';
      RELATE node:node_b1->edge:edge_b_intra->node:node_b2 SET weight = 0.9, type = 'explicit';
      RELATE node:node_b3->edge:edge_b_container->node:node_b4 SET weight = 0.37, type = 'co_activation';
    `);

    // Simulates a malicious admin action or a root-side script writing a
    // cross-tenant edge. Tenant sessions cannot create this (the create
    // permission checks both endpoints), so it has to come from root. Created
    // once here rather than inside a test so every test sees the same graph.
    await rootDb.query(`
      RELATE node:node_a1->edge:edge_a_to_b->node:node_b1 SET weight = 0.55, type = 'explicit';
    `);
  });

  afterAll(async () => {
    await rootDb?.close();
  });

  it('tenant A can see own nodes via arrow traversal', async () => {

    const dbA = await createTenantSession('tenant_a', 'user_a');
    try {
      // Arrow traversal from node_a1 should return node_a2
      const result = await dbA.query<{ neighbors: { id: string }[] }>(
        "SELECT ->edge->node AS neighbors FROM node:node_a1"
      );

      const neighbors = result[0]?.neighbors ?? [];
      expect(neighbors.length).toBe(1);
      expect(String(neighbors[0]?.id)).toContain('node_a2');
    } finally {
      await dbA.close();
    }
  });

  it('tenant A cannot see tenant B nodes via arrow traversal', async () => {

    // The root-created cross-tenant edge (edge_a_to_b) is seeded in beforeAll.
    const dbA = await createTenantSession('tenant_a', 'user_a');
    try {
      // Arrow traversal from node_a1 should NOT return node_b1 (node RLS blocks)
      const result = await dbA.query<{ neighbors: { id: string }[] }>(
        "SELECT ->edge->node AS neighbors FROM node:node_a1"
      );

      const neighbors = result[0]?.neighbors ?? [];
      // Should only see node_a2, not node_b1
      const neighborIds = neighbors.map(n => String(n.id));
      expect(neighborIds).not.toContain('node:node_b1');
      expect(neighborIds.some(id => id.includes('node_a2'))).toBe(true);
    } finally {
      await dbA.close();
    }
  });

  it('tenant A cannot RELATE to tenant B nodes', async () => {

    const dbA = await createTenantSession('tenant_a', 'user_a');
    try {
      // Attempt to create cross-tenant edge should fail (RLS on CREATE)
      const edges = await dbA.query<unknown>(
        "RELATE node:node_a1->edge->node:node_b1 SET weight = 0.7, type = 'explicit'"
      );

      // Edge should not be created (empty result or error)
      expect(edges.length).toBe(0);
    } finally {
      await dbA.close();
    }
  });

  it('tenant A can RELATE own nodes', async () => {

    const dbA = await createTenantSession('tenant_a', 'user_a');
    try {
      // Create new nodes as tenant A (real schema: source + session refs required)
      await dbA.query(`
        CREATE node:node_a3 SET content = 'Node A3', source = 'test', tenant = tenant:tenant_a, type = 'observation', session_created = session:sess_a, session_activated = session:sess_a;
        CREATE node:node_a4 SET content = 'Node A4', source = 'test', tenant = tenant:tenant_a, type = 'observation', session_created = session:sess_a, session_activated = session:sess_a;
      `);

      // Create edge between own nodes
      const edges = await dbA.query<{ id: string }>(
        "RELATE node:node_a3->edge->node:node_a4 SET weight = 0.6, type = 'explicit'"
      );

      expect(edges.length).toBe(1);
    } finally {
      await dbA.close();
    }
  });

  it('edge metadata (weight, type) is accessible via arrow syntax', async () => {

    const dbA = await createTenantSession('tenant_a', 'user_a');
    try {
      // In SurrealDB v3, `SELECT ->edge` in a projection returns record ids,
      // not edge objects. To read edge metadata via arrow syntax, select the
      // fields FROM the traversal — same pattern production uses in
      // getNeighborsWithWeightsBatch (tools/query.ts).
      const edges = await dbA.query<{ out: unknown; weight: number; type: string }>(
        "SELECT out, weight, type FROM node:node_a1->edge"
      );

      expect(edges.length).toBeGreaterThan(0);
      for (const edge of edges) {
        expect(typeof edge.weight).toBe('number');
        expect(typeof edge.type).toBe('string');
      }
      // The seeded node_a1 -> node_a2 edge must surface its exact metadata
      const seeded = edges.find((e) => String(e.out).includes('node_a2'));
      expect(seeded).toBeDefined();
      expect(seeded?.weight).toBe(0.8);
      expect(seeded?.type).toBe('explicit');
    } finally {
      await dbA.close();
    }
  });

  it('bidirectional traversal works correctly', async () => {

    const dbA = await createTenantSession('tenant_a', 'user_a');
    try {
      // <->edge<-> returns neighbors in both directions
      const result = await dbA.query<{ neighbors: { id: string }[] }>(
        "SELECT <->edge<->node AS neighbors FROM node:node_a2"
      );

      const neighbors = result[0]?.neighbors ?? [];
      // node_a2 is connected to node_a1 via inbound edge
      expect(neighbors.length).toBeGreaterThan(0);
      const neighborIds = neighbors.map(n => String(n.id));
      expect(neighborIds.some(id => id.includes('node_a1'))).toBe(true);
    } finally {
      await dbA.close();
    }
  });

  it('inbound edge traversal works correctly', async () => {

    const dbA = await createTenantSession('tenant_a', 'user_a');
    try {
      // <-edge<- returns inbound neighbors
      const result = await dbA.query<{ neighbors: { id: string }[] }>(
        "SELECT <-edge<-node AS neighbors FROM node:node_a2"
      );

      const neighbors = result[0]?.neighbors ?? [];
      // node_a2 receives edge from node_a1
      expect(neighbors.length).toBe(1);
      expect(String(neighbors[0]?.id)).toContain('node_a1');
    } finally {
      await dbA.close();
    }
  });

  // ------------------------------------------------------------------
  // LYT-264: direct reads of the edge table as tenant A.
  //
  // The tests above go through node traversal, where node RLS filters the
  // endpoints. These read the edge table itself, so only the edge table's own
  // SELECT permission can hide a row. Edges that touch a B node are the
  // "foreign" set: tenant A must never see them, including the root-created
  // A-to-B edge.
  // ------------------------------------------------------------------

  // DECISION (LYT-264, 2026-11): `edge` keeps `FOR select FULL`. A scoped select
  // (in.tenant / out.tenant = caller's tenant) measured several times slower on
  // the spread and activation queries (see src/benchmarks/perf/edge-permission-cost.ts),
  // well past the +20% p50 budget. The tests below marked `it.fails` therefore
  // document the ACCEPTED exposure: a tenant session can read other tenants'
  // edge rows (ids, weights, types; never node content, node RLS still applies).
  // `it.fails` passes while the exposure exists and turns RED the day the edge
  // select is scoped: at that point flip each to `it(` so it guards the fix.
  // The positive control below keeps a broken fixture from passing them vacuously.
  // Revisit trigger: a denormalised `tenant` field on `edge` (no dereference in
  // the predicate), tracked as a follow-up.

  it('positive control: tenant A reads its own seeded edge directly and by traversal', async () => {
    const dbA = await createTenantSession('tenant_a', 'user_a');
    try {
      const own = await dbA.query<{ id: unknown }>('SELECT * FROM edge:edge_a_intra');
      expect(own).toHaveLength(1);
      const outs = await dbA.query<{ out: unknown; weight: number }>('SELECT out, weight FROM node:node_a1->edge');
      expect(outs.some((r) => String(r.out).includes('node_a2') && r.weight === 0.8)).toBe(true);
    } finally {
      await dbA.close();
    }
  });

  const FOREIGN_EDGES = ['edge:edge_b_intra', 'edge:edge_b_container', 'edge:edge_a_to_b'];

  const idsOf = (rows: { id: unknown }[]) => rows.map((r) => String(r.id));

  it.fails('tenant A direct SELECT * FROM edge returns none of the foreign edges and its own edge', async () => {
    const dbA = await createTenantSession('tenant_a', 'user_a');
    try {
      const rows = await dbA.query<{ id: unknown }>('SELECT * FROM edge');
      const ids = idsOf(rows);
      for (const foreign of FOREIGN_EDGES) expect(ids).not.toContain(foreign);
      expect(ids).toContain('edge:edge_a_intra');
    } finally {
      await dbA.close();
    }
  });

  it.fails('tenant A cannot select a tenant B edge by id, but can select its own', async () => {
    const dbA = await createTenantSession('tenant_a', 'user_a');
    try {
      const foreign = await dbA.query<{ id: unknown }>('SELECT * FROM edge:edge_b_intra');
      expect(foreign).toHaveLength(0);
      const own = await dbA.query<{ id: unknown }>('SELECT * FROM edge:edge_a_intra');
      expect(own).toHaveLength(1);
    } finally {
      await dbA.close();
    }
  });

  it('tenant A cannot find tenant B edges by filtering on the endpoint container', async () => {
    const dbA = await createTenantSession('tenant_a', 'user_a');
    try {
      const rows = await dbA.query<{ id: unknown }>(
        "SELECT * FROM edge WHERE in.container = container:ct_b OR out.container = container:ct_b"
      );
      expect(rows).toHaveLength(0);
    } finally {
      await dbA.close();
    }
  });

  it.fails('tenant A cannot read the root-created cross-tenant edge directly', async () => {
    const dbA = await createTenantSession('tenant_a', 'user_a');
    try {
      const byId = await dbA.query<{ id: unknown }>('SELECT * FROM edge:edge_a_to_b');
      expect(byId).toHaveLength(0);
      // Unambiguous leak check: B's endpoint id or the edge's metadata must not
      // appear in anything tenant A can select from the edge table.
      const all = await dbA.query<Record<string, unknown>>('SELECT in, out, weight, type FROM edge');
      const serialized = JSON.stringify(all.map((r) => ({ in: String(r.in), out: String(r.out), w: r.weight })));
      expect(serialized).not.toContain('node_b');
    } finally {
      await dbA.close();
    }
  });

  it.fails('traversal from a tenant A node does not expose the cross-tenant edge row', async () => {
    const dbA = await createTenantSession('tenant_a', 'user_a');
    try {
      // Reads edge rows (not nodes): `out` is a plain field, so no node RLS runs.
      const rows = await dbA.query<{ out: unknown; weight: number }>(
        'SELECT out, weight FROM node:node_a1->edge'
      );
      const outs = rows.map((r) => String(r.out));
      expect(outs.some((o) => o.includes('node_b'))).toBe(false);
      expect(rows.some((r) => r.weight === 0.55)).toBe(false);
      expect(outs.some((o) => o.includes('node_a2'))).toBe(true);
    } finally {
      await dbA.close();
    }
  });

  // ------------------------------------------------------------------
  // LYT-264: edge-by-start-ID traversal. This never dereferences a node, so
  // node RLS is not consulted at all; only the edge SELECT permission can
  // stop it. It is the exact shape of getNeighborsWithWeightsBatch.
  // ------------------------------------------------------------------

  it.fails('tenant A cannot walk tenant B edges from a B node id (outbound and inbound)', async () => {
    const dbA = await createTenantSession('tenant_a', 'user_a');
    try {
      const outbound = await dbA.query<{ in: unknown; out: unknown; weight: number }>(
        "SELECT in, out, weight FROM [type::record('node', 'node_b1')]->edge"
      );
      expect(outbound).toHaveLength(0);
      // node_b1 also has the root-created inbound edge from node_a1.
      const inbound = await dbA.query<{ in: unknown; out: unknown; weight: number }>(
        "SELECT in, out, weight FROM [type::record('node', 'node_b1')]<-edge"
      );
      expect(inbound).toHaveLength(0);
    } finally {
      await dbA.close();
    }
  });

  it.fails('getNeighborsWithWeightsBatch never reports a tenant B neighbour, over two hops', async () => {
    const dbA = await createTenantSession('tenant_a', 'user_a');
    try {
      // Mimics spreadingActivation: hop 0 from the seed, hop 1 from whatever
      // hop 0 returned (those ids are NOT re-filtered by node RLS).
      const seen = new Set<string>();
      let frontier = ['node:node_a1'];
      for (let hop = 0; hop < 2; hop++) {
        const bySource = await getNeighborsWithWeightsBatch(dbA, frontier);
        const next: string[] = [];
        for (const edges of bySource.values()) {
          for (const e of edges) {
            seen.add(e.neighbor);
            next.push(e.neighbor);
          }
        }
        frontier = next;
        if (frontier.length === 0) break;
      }
      expect([...seen].some((id) => id.includes('node_b'))).toBe(false);
      expect([...seen].some((id) => id.includes('node_a2'))).toBe(true);
    } finally {
      await dbA.close();
    }
  });

  it('kg_query spread activation as tenant A returns nothing of tenant B', async () => {
    const dbA = await createTenantSession('tenant_a', 'user_a');
    try {
      const result = await queryTool.execute(
        dbA,
        noopEmbed,
        {
          claims: { sub: 'user_a', tenantId: 'tenant_a', projects: [], scope: 'kg:read kg:write', principals: [], tier: 'free' },
          tenantId: 'tenant_a',
          projects: [],
          scope: 'kg:read kg:write',
          currentSession: 'session:sess_a',
        },
        { type: 'observation', spread: true, spread_hops: 2, limit: 100 } as never
      );
      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('node_a1');
      expect(text).not.toContain('node_b');
      expect(text).not.toContain('Node B');
    } finally {
      await dbA.close();
    }
  });
});
