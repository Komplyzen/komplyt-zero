/**
 * Integration tests for Edge TYPE RELATION tenant isolation
 *
 * Tests verify:
 * 1. Tenant A cannot RELATE to tenant B nodes (RLS on CREATE)
 * 2. Arrow traversal respects node-level tenant RLS
 * 3. Edge metadata (weight, type) is accessible via arrow syntax
 *
 * Run with: bun run vitest run edge-tenant-isolation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { KgDbClient } from '../contracts.js';
import { dbFactory } from '../db.js';
import { connectTestDb, wipeData } from './connect.js';

let rootDb: Surreal;

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

    // Create edges within each tenant (as root, bypassing RLS)
    await rootDb.query(`
      RELATE node:node_a1->edge->node:node_a2 SET weight = 0.8, type = 'explicit';
      RELATE node:node_b1->edge->node:node_b2 SET weight = 0.9, type = 'explicit';
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

    // As root, create a cross-tenant edge (simulating malicious admin action)
    // type must pass the real schema ASSERT ('explicit' | 'co_activation')
    await rootDb.query(`
      RELATE node:node_a1->edge->node:node_b1 SET weight = 0.5, type = 'explicit';
    `);

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
});
