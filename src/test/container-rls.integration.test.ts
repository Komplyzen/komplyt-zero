/**
 * Integration tests for Container/Grants RLS
 *
 * Tests verify the graph traversal RLS actually works against real SurrealDB v3.
 * Uses TYPE RECORD signin pattern (TYPE JWT bypasses RLS in v3).
 * Runs against the externally-provisioned test database (real migration chain),
 * signing in against the real `kg_server` access (migration 006) — only the
 * seed data is test-local.
 *
 * ENGINE VERSION MATTERS (postscript, resolved 2026-08-25): on
 * SurrealDB v3.0.0 closures inside PERMISSIONS clauses cannot resolve row
 * fields during SELECT evaluation, which made all grant-visibility tests
 * fail (confirmed by 8-case isolated bisect). The bug is FIXED on the
 * deployed Cloud engine and on v3.2.4+ — verified against both on
 * 2026-08-25. If the 4 grant tests fail locally, your local SurrealDB
 * image is too old: use surrealdb/surrealdb:v3.2.4 or newer.
 *
 * Run with: bun run vitest run container-rls.integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { KgDbClient } from '../contracts.js';
import { dbFactory } from '../db.js';
import { connectTestDb, wipeData } from './connect.js';

let rootDb: Surreal;

function principalId(type: 'User' | 'Tenant' | 'Project', refId: string): string {
  return `principal:${type.toLowerCase()}_${refId}`;
}

function buildPrincipals(userId: string, tenantId: string, projects: string[]): string[] {
  const principals: string[] = [principalId('User', userId)];
  if (tenantId && tenantId.length > 0) {
    principals.push(principalId('Tenant', tenantId));
  }
  for (const projectId of projects) {
    principals.push(principalId('Project', projectId));
  }
  return principals;
}

describe('Container RLS Integration', () => {
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

    // Test data - granted_principals on containers instead of granted relation (v3 RLS limitation).
    // Real node schema requires content, source, type, session_created, session_activated.
    await rootDb.query(`
      CREATE tenant:acme SET name = 'Acme Corp';
      CREATE tenant:competitor SET name = 'Competitor Inc';

      CREATE session:seed_acme SET tenant = tenant:acme;
      CREATE session:seed_competitor SET tenant = tenant:competitor;

      CREATE principal:user_alice SET type = 'User', ref_id = 'alice';
      CREATE principal:user_bob SET type = 'User', ref_id = 'bob';
      CREATE principal:tenant_acme SET type = 'Tenant', ref_id = 'acme';
      CREATE principal:tenant_competitor SET type = 'Tenant', ref_id = 'competitor';
      CREATE principal:project_alpha SET type = 'Project', ref_id = 'alpha';

      CREATE container:acme_company SET name = 'Company Knowledge', tenant = tenant:acme, owner = principal:tenant_acme, granted_principals = [principal:tenant_acme];
      CREATE container:acme_private_alice SET name = 'Alice Private', tenant = tenant:acme, owner = principal:user_alice, granted_principals = [principal:user_alice];
      CREATE container:acme_project_alpha SET name = 'Project Alpha', tenant = tenant:acme, owner = principal:project_alpha, granted_principals = [principal:project_alpha];
      CREATE container:competitor_company SET name = 'Company Knowledge', tenant = tenant:competitor, owner = principal:tenant_competitor, granted_principals = [principal:tenant_competitor];

      CREATE node:acme_public SET content = 'Acme public knowledge', type = 'observation', source = 'test', session_created = session:seed_acme, session_activated = session:seed_acme, tenant = tenant:acme, container = container:acme_company;
      CREATE node:alice_private SET content = 'Alice private note', type = 'observation', source = 'test', session_created = session:seed_acme, session_activated = session:seed_acme, tenant = tenant:acme, container = container:acme_private_alice;
      CREATE node:alpha_project SET content = 'Project Alpha doc', type = 'observation', source = 'test', session_created = session:seed_acme, session_activated = session:seed_acme, tenant = tenant:acme, container = container:acme_project_alpha;
      CREATE node:competitor_secret SET content = 'Competitor secret', type = 'observation', source = 'test', session_created = session:seed_competitor, session_activated = session:seed_competitor, tenant = tenant:competitor, container = container:competitor_company;
      CREATE node:legacy_no_container SET content = 'Legacy node', type = 'observation', source = 'test', session_created = session:seed_acme, session_activated = session:seed_acme, tenant = tenant:acme, container = NONE;
    `);
  });

  afterAll(async () => {
    await rootDb?.close();
  });

  // Tenant-scoped client via the standard factory — signs in against the real
  // `kg_server` access (migration 006) so RLS applies via $auth.
  async function createScopedClient(userId: string, tenantId: string, projects: string[] = []): Promise<KgDbClient> {
    return dbFactory.createScoped({
      sub: userId,
      tenantId,
      scope: 'kg:read kg:write',
      principals: buildPrincipals(userId, tenantId, projects),
      projects,
      tier: 'free',
    });
  }

  async function queryFirst<T>(db: KgDbClient, sql: string): Promise<T[]> {
    return db.query<T>(sql);
  }

  describe('Tenant Boundary (Hard)', () => {
    it('user cannot see nodes from other tenant', async () => {
      const db = await createScopedClient('alice', 'acme');
      try {
        const nodes = await queryFirst<{ content: string }>(db, 'SELECT content FROM node');
        const contents = nodes.map(n => n.content);
        expect(contents).not.toContain('Competitor secret');
      } finally {
        await db.close();
      }
    });

    it('user cannot see containers from other tenant', async () => {
      const db = await createScopedClient('alice', 'acme');
      try {
        const containers = await queryFirst<{ name: string }>(db, 'SELECT name FROM container');
        const names = containers.map(c => c.name);
        expect(names).not.toContain('Competitor Company Knowledge');
      } finally {
        await db.close();
      }
    });
  });

  describe('Container Grant Access', () => {
    it('team user sees company container nodes', async () => {
      const db = await createScopedClient('alice', 'acme');
      try {
        const nodes = await queryFirst<{ content: string }>(db, 'SELECT content FROM node');
        const contents = nodes.map(n => n.content);
        expect(contents).toContain('Acme public knowledge');
      } finally {
        await db.close();
      }
    });

    it('user sees own private container', async () => {
      const db = await createScopedClient('alice', 'acme');
      try {
        const nodes = await queryFirst<{ content: string }>(db, 'SELECT content FROM node');
        const contents = nodes.map(n => n.content);
        expect(contents).toContain('Alice private note');
      } finally {
        await db.close();
      }
    });

    it('user cannot see other user private container', async () => {
      const db = await createScopedClient('bob', 'acme');
      try {
        const nodes = await queryFirst<{ content: string }>(db, 'SELECT content FROM node');
        const contents = nodes.map(n => n.content);
        expect(contents).not.toContain('Alice private note');
      } finally {
        await db.close();
      }
    });

    it('project member sees project container', async () => {
      const db = await createScopedClient('alice', 'acme', ['alpha']);
      try {
        const nodes = await queryFirst<{ content: string }>(db, 'SELECT content FROM node');
        const contents = nodes.map(n => n.content);
        expect(contents).toContain('Project Alpha doc');
      } finally {
        await db.close();
      }
    });

    it('non-project member cannot see project container', async () => {
      const db = await createScopedClient('bob', 'acme', []);
      try {
        const nodes = await queryFirst<{ content: string }>(db, 'SELECT content FROM node');
        const contents = nodes.map(n => n.content);
        expect(contents).not.toContain('Project Alpha doc');
      } finally {
        await db.close();
      }
    });
  });

  describe('Legacy Nodes (container = NONE)', () => {
    it('team user can see legacy nodes without container', async () => {
      const db = await createScopedClient('alice', 'acme');
      try {
        const nodes = await queryFirst<{ content: string }>(db, 'SELECT content FROM node WHERE container = NONE');
        const contents = nodes.map(n => n.content);
        expect(contents).toContain('Legacy node');
      } finally {
        await db.close();
      }
    });
  });

  describe('Multi-Principal Resolution', () => {
    it('user with multiple principals sees all granted containers', async () => {
      const db = await createScopedClient('alice', 'acme', ['alpha']);
      try {
        const nodes = await queryFirst<{ content: string }>(db, 'SELECT content FROM node');
        const contents = nodes.map(n => n.content);

        expect(contents).toContain('Acme public knowledge');
        expect(contents).toContain('Alice private note');
        expect(contents).toContain('Project Alpha doc');
        expect(contents).toContain('Legacy node');
        expect(contents).not.toContain('Competitor secret');
      } finally {
        await db.close();
      }
    });
  });

  describe('Node Creation', () => {
    it('can create node in granted container', async () => {
      const db = await createScopedClient('alice', 'acme');
      try {
        const result = await queryFirst<{ id: string }>(
          db,
          `CREATE node SET content = 'Test node', type = 'observation', source = 'test', session_created = session:seed_acme, session_activated = session:seed_acme, tenant = tenant:acme, container = container:acme_company RETURN id`
        );
        expect(result.length).toBe(1);
        expect(result[0].id).toBeDefined();
      } finally {
        await db.close();
      }
    });

    it('cannot create node in ungranted container', async () => {
      const db = await createScopedClient('bob', 'acme');
      try {
        const result = await queryFirst<{ id: string }>(
          db,
          `CREATE node SET content = 'Sneaky node', type = 'observation', source = 'test', session_created = session:seed_acme, session_activated = session:seed_acme, tenant = tenant:acme, container = container:acme_private_alice RETURN id`
        );
        expect(result.length).toBe(0);
      } finally {
        await db.close();
      }
    });
  });

  describe('FOR delete NONE', () => {
    // The purge job's root connection must remain the ONLY delete path.
    // A migration relaxing FOR delete on node/edge/container would hand
    // tenants a hard-delete route with every other test still green —
    // this pins the constraint. DELETE under RLS is a silent no-op, so
    // the assertion is "the records still exist as root".
    it('tenant-scoped connection cannot delete nodes or containers', async () => {
      const db = await createScopedClient('alice', 'acme');
      try {
        // Both silent no-op and explicit permission error are acceptable
        // denials — what matters is the records survive.
        await db.query('DELETE node:acme_public').catch(() => []);
        await db.query('DELETE container:acme_company').catch(() => []);
      } finally {
        await db.close();
      }

      const nodes = await rootDb.query<[{ id: unknown }[]]>('SELECT id FROM node:acme_public');
      expect(nodes.flat()).toHaveLength(1);
      const containers = await rootDb.query<[{ id: unknown }[]]>('SELECT id FROM container:acme_company');
      expect(containers.flat()).toHaveLength(1);
    });
  });
});
