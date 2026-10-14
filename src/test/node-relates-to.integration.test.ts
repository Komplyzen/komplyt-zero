/**
 * Integration test for kg_node_create relates_to parameter
 *
 * Verifies that relates_to creates edges using RELATE syntax (not CREATE edge SET).
 * Bug: CREATE edge SET doesn't work with TYPE RELATION tables; edges were silently not created.
 *
 * Run with: bun run vitest run node-relates-to
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { nodeCreateTool } from '../tools/node-create.js';
import { KgDbClient, KgTokenPayload, ToolContext } from '../contracts.js';
import { dbFactory } from '../db.js';
import { connectTestDb, wipeData } from './connect.js';

let rootDb: Surreal;

const mockEmbed = {
  embedDocuments: async (texts: string[]) => texts.map(() => Array(1024).fill(0.1)),
  embedQuery: async () => Array(1024).fill(0.1),
  model: 'test-mock',
  dimensions: 1024 as const,
};

/**
 * Tenant-scoped client via the standard factory — signs in against the real
 * `kg_server` access (migration 006) so RLS applies via $auth.
 */
async function createTenantClient(tenantId: string, userId: string): Promise<KgDbClient> {
  return dbFactory.createScoped(claimsFor(tenantId, userId));
}

function claimsFor(tenantId: string, userId: string): KgTokenPayload {
  return {
    sub: userId,
    tenantId,
    scope: 'kg:read kg:write',
    principals: [`principal:user_${userId}`, `principal:tenant_${tenantId}`],
    projects: [],
    tier: 'free',
  };
}

describe('kg_node_create relates_to edge creation', () => {
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

    // Seed data (as root, bypassing RLS).
    // The real node RLS requires container.granted_principals to contain one
    // of $auth.principals, so the container is granted to both test principals.
    await rootDb.query(`
      CREATE tenant:test_tenant SET name = 'Test Tenant';
      CREATE project:test_project SET name = 'Test Project', tenant = tenant:test_tenant;
      CREATE session:test_session SET
        tenant = tenant:test_tenant,
        project = project:test_project,
        session_num = 1;
      CREATE principal:user_test_user SET type = 'User', ref_id = 'test_user';
      CREATE principal:tenant_test_tenant SET type = 'Tenant', ref_id = 'test_tenant';
      CREATE container:test_container SET
        name = 'Company Knowledge',
        tenant = tenant:test_tenant,
        owner = principal:tenant_test_tenant,
        granted_principals = [principal:user_test_user, principal:tenant_test_tenant];
    `);

    // Create a target node for relates_to.
    //
    // container = NONE (a valid state: node.container is optional): on SurrealDB v3.0.0 the node RLS closure
    // (array::any($auth.principals, |$p| { ... container.granted_principals ... }))
    // cannot see row fields inside the closure body during SELECT permission
    // evaluation, so nodes with a container are invisible to record-auth
    // sessions even when the principal is granted. Targets must therefore be
    // container-less for the tool's tenant-scoped visibility check to see them.
    // (Same engine bug makes container-rls.integration.test.ts fail.)
    await rootDb.query(`
      CREATE node:target_node SET
        content = 'Target node for relates_to test',
        tenant = tenant:test_tenant,
        type = 'observation',
        source = 'test',
        author = author:test_user,
        container = NONE,
        project = project:test_project,
        session_created = session:test_session,
        session_activated = session:test_session,
        decay_score = 1.0;
    `);
  });

  afterAll(async () => {
    await rootDb?.close();
  });

  it('creates edge when relates_to is provided', async () => {
    const dbClient = await createTenantClient('test_tenant', 'test_user');
    try {
      const ctx: ToolContext = {
        tenantId: 'test_tenant',
        currentSession: 'session:test_session',
        projects: [],
        scope: 'kg:read kg:write',
        claims: claimsFor('test_tenant', 'test_user'),
      };

      const result = await nodeCreateTool.execute(dbClient, mockEmbed, ctx, {
        type: 'observation',
        content: 'Test node with relates_to',
        relates_to: ['node:target_node'],
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text);
      expect(data.edges_created).toBe(1);

      // Verify edge was created via arrow traversal.
      // Verified as root: the created node gets the default container, and the
      // v3.0.0 RLS closure limitation (see beforeAll) makes it — and thus
      // traversal FROM it — invisible to the record-auth session.
      const edgeCheck = await rootDb.query<{ neighbors: { id: string }[] }[]>(
        `SELECT ->edge->node AS neighbors FROM type::record('node', $id)`,
        { id: data.id.replace('node:', '') }
      );

      const neighbors = edgeCheck.flat()[0]?.neighbors ?? [];
      expect(neighbors.length).toBe(1);
      expect(String(neighbors[0]?.id)).toContain('target_node');
    } finally {
      await dbClient.close();
    }
  });

  it('creates multiple edges when relates_to has multiple targets', async () => {
    const dbClient = await createTenantClient('test_tenant', 'test_user');
    try {
      // Create a second target node (container = NONE — see beforeAll note on
      // the v3.0.0 RLS closure limitation)
      await dbClient.query(`
        CREATE node:target_node_2 SET
          content = 'Second target node',
          tenant = tenant:test_tenant,
          type = 'observation',
          source = 'test',
          author = author:test_user,
          container = NONE,
          project = project:test_project,
          session_created = session:test_session,
          session_activated = session:test_session,
          decay_score = 1.0;
      `);

      const ctx: ToolContext = {
        tenantId: 'test_tenant',
        currentSession: 'session:test_session',
        projects: [],
        scope: 'kg:read kg:write',
        claims: claimsFor('test_tenant', 'test_user'),
      };

      const result = await nodeCreateTool.execute(dbClient, mockEmbed, ctx, {
        type: 'observation',
        content: 'Test node with multiple relates_to',
        relates_to: ['node:target_node', 'node:target_node_2'],
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text);
      expect(data.edges_created).toBe(2);

      // Verify both edges via arrow traversal (as root — see first test)
      const edgeCheck = await rootDb.query<{ neighbors: { id: string }[] }[]>(
        `SELECT ->edge->node AS neighbors FROM type::record('node', $id)`,
        { id: data.id.replace('node:', '') }
      );

      const neighbors = edgeCheck.flat()[0]?.neighbors ?? [];
      expect(neighbors.length).toBe(2);
    } finally {
      await dbClient.close();
    }
  });

  it('deduplicates relates_to targets', async () => {
    const dbClient = await createTenantClient('test_tenant', 'test_user');
    try {
      const ctx: ToolContext = {
        tenantId: 'test_tenant',
        currentSession: 'session:test_session',
        projects: [],
        scope: 'kg:read kg:write',
        claims: claimsFor('test_tenant', 'test_user'),
      };

      // Pass same target twice
      const result = await nodeCreateTool.execute(dbClient, mockEmbed, ctx, {
        type: 'observation',
        content: 'Test node with duplicate relates_to',
        relates_to: ['node:target_node', 'node:target_node'],
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text);
      // Should only create 1 edge, not 2
      expect(data.edges_created).toBe(1);

      // Verify only 1 edge exists in DB (not just trusting the counter; as
      // root — see first test)
      const edgeCheck = await rootDb.query<{ neighbors: { id: string }[] }[]>(
        `SELECT ->edge->node AS neighbors FROM type::record('node', $id)`,
        { id: data.id.replace('node:', '') }
      );
      const neighbors = edgeCheck.flat()[0]?.neighbors ?? [];
      expect(neighbors.length).toBe(1);
    } finally {
      await dbClient.close();
    }
  });

  it('rejects relates_to with more than 20 targets without creating node', async () => {
    const dbClient = await createTenantClient('test_tenant', 'test_user');
    try {
      // Count nodes before
      const nodesBefore = await dbClient.queryOne<{ count: number }>(
        `SELECT count() AS count FROM node WHERE tenant = tenant:test_tenant GROUP ALL`
      );
      const countBefore = nodesBefore?.count ?? 0;

      const ctx: ToolContext = {
        tenantId: 'test_tenant',
        currentSession: 'session:test_session',
        projects: [],
        scope: 'kg:read kg:write',
        claims: claimsFor('test_tenant', 'test_user'),
      };

      // Create 25 unique targets (exceeds limit of 20)
      const manyTargets = Array.from({ length: 25 }, (_, i) => `node:target_${i}`);

      const result = await nodeCreateTool.execute(dbClient, mockEmbed, ctx, {
        type: 'observation',
        content: 'Test node with too many relates_to',
        relates_to: manyTargets,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('exceeds limit');

      // Verify no node was created (validation happens before node creation)
      const nodesAfter = await dbClient.queryOne<{ count: number }>(
        `SELECT count() AS count FROM node WHERE tenant = tenant:test_tenant GROUP ALL`
      );
      const countAfter = nodesAfter?.count ?? 0;
      expect(countAfter).toBe(countBefore);
    } finally {
      await dbClient.close();
    }
  });

  it('handles empty string in relates_to gracefully', async () => {
    const dbClient = await createTenantClient('test_tenant', 'test_user');
    try {
      const ctx: ToolContext = {
        tenantId: 'test_tenant',
        currentSession: 'session:test_session',
        projects: [],
        scope: 'kg:read kg:write',
        claims: claimsFor('test_tenant', 'test_user'),
      };

      // Empty string and malformed ID should be skipped, not crash
      const result = await nodeCreateTool.execute(dbClient, mockEmbed, ctx, {
        type: 'observation',
        content: 'Test node with empty relates_to target',
        relates_to: ['', 'node:', 'invalid-format'],
      });

      // Node should be created, but no edges (all targets invalid)
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text);
      expect(data.edges_created).toBe(0);
    } finally {
      await dbClient.close();
    }
  });

  it('returns edges_created: 0 when relates_to target does not exist', async () => {
    const dbClient = await createTenantClient('test_tenant', 'test_user');
    try {
      const ctx: ToolContext = {
        tenantId: 'test_tenant',
        currentSession: 'session:test_session',
        projects: [],
        scope: 'kg:read kg:write',
        claims: claimsFor('test_tenant', 'test_user'),
      };

      const result = await nodeCreateTool.execute(dbClient, mockEmbed, ctx, {
        type: 'observation',
        content: 'Test node with invalid relates_to',
        relates_to: ['node:nonexistent_node'],
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text);
      // Target doesn't exist, so no edge created (but node creation succeeds)
      expect(data.edges_created).toBe(0);
    } finally {
      await dbClient.close();
    }
  });
});
