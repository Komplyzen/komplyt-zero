// SPDX-License-Identifier: Elastic-2.0
// Copyright 2024-2026 Komplyzen GmbH. Licensed under the Elastic License 2.0; see LICENSE in this directory.

/**
 * Integration tests for container purge (CAP-1) and admin soft-delete (CAP-2)
 *.
 *
 * Verifies the actual cascade/atomicity semantics against real SurrealDB v3:
 * eligibility windows, restore races, cross-container edge cascade, atomic
 * audit records, delete/restore/delete cycles.
 *
 * Run with: bun run vitest run container-purge.integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import type { MiddlewareHandler } from 'hono';
import { runPurge, purgeContainer } from '../purge.js';
import { adminSoftDelete } from '../admin-delete.js';
import { connectTestDb, wipeData } from '../../test/connect.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let rootDb: Surreal;

async function queryAll<T>(db: Surreal, sql: string, vars?: Record<string, unknown>): Promise<T[]> {
  const result = await db.query<[T[]]>(sql, vars);
  return result[0] ?? [];
}

/** Create a container with optional soft-delete timestamps (days ago) */
async function seedContainer(
  id: string,
  opts: { firstDeletedDaysAgo?: number; deletedDaysAgo?: number; tenant?: string } = {}
): Promise<void> {
  const tenant = opts.tenant ?? 'test';
  const firstDeleted =
    opts.firstDeletedDaysAgo !== undefined
      ? new Date(Date.now() - opts.firstDeletedDaysAgo * DAY_MS).toISOString()
      : null;
  const deleted =
    opts.deletedDaysAgo !== undefined
      ? new Date(Date.now() - opts.deletedDaysAgo * DAY_MS).toISOString()
      : null;

  await rootDb.query(
    `CREATE type::record('container', $id) SET
       name = $id,
       tenant = type::record('tenant', $tenant),
       owner = type::record('principal', 'user_alice'),
       created_at = time::now(),
       deleted_at = ${deleted ? 'type::datetime($deleted)' : 'NONE'},
       first_deleted_at = ${firstDeleted ? 'type::datetime($first_deleted)' : 'NONE'}`,
    { id, tenant, deleted, first_deleted: firstDeleted }
  );
}

async function seedNode(id: string, containerId: string | null): Promise<void> {
  await rootDb.query(
    `CREATE type::record('node', $id) SET
       content = $id,
       type = 'observation',
       source = 'test',
       session_created = type::record('session', 'test_session'),
       session_activated = type::record('session', 'test_session'),
       tenant = type::record('tenant', 'test'),
       container = ${containerId ? "type::record('container', $container)" : 'NONE'}`,
    { id, container: containerId }
  );
}

/**
 * Edges are RELATE-created (edge is TYPE RELATION in the real schema), so
 * their ids are generated — tests identify edges by their in/out endpoints.
 */
async function seedEdge(from: string, to: string): Promise<void> {
  await rootDb.query(
    `RELATE (type::record('node', $from))->edge->(type::record('node', $to)) SET
       type = 'explicit',
       weight = 1.0`,
    { from, to }
  );
}

async function edgeEndpoints(): Promise<Array<{ in: string; out: string }>> {
  const rows = await queryAll<{ in: unknown; out: unknown }>(rootDb, `SELECT in, out FROM edge`);
  return rows.map((r) => ({ in: String(r.in), out: String(r.out) }));
}

async function ids(table: string): Promise<string[]> {
  const rows = await queryAll<{ id: unknown }>(rootDb, `SELECT id FROM type::table($t)`, { t: table });
  return rows.map((r) => String(r.id));
}

describe('Container Purge Integration', () => {
  let skipTests = false;

  // Runtime skip: a skipped test must REPORT as skipped. The old
  // `if (skipTests) return` pattern counted empty test bodies as PASSED
  // (weeks of green CI over zero assertions).
  beforeEach((ctx) => {
    if (skipTests) ctx.skip();
  });

  beforeAll(async () => {
    const db = await connectTestDb();
    if (!db) {
      skipTests = true;
      return;
    }
    rootDb = db;
    await wipeData(rootDb);

    // Tests run as root, so RLS/PERMISSIONS NONE do not block them; the RLS
    // behavior itself is covered by container-rls tests.
    await rootDb.query(`
      CREATE tenant:test SET name = 'Test Corp';
      CREATE tenant:other SET name = 'Other Corp';
      CREATE principal:user_alice SET type = 'User', ref_id = 'alice';
      CREATE session:test_session SET tenant = type::record('tenant', 'test');
    `);
  });

  beforeEach(async () => {
    await rootDb.query(`DELETE meta_model; DELETE training_run; DELETE edge; DELETE node; DELETE container; DELETE audit_log;`);
  });

  afterAll(async () => {
    await rootDb?.close();
  });

  describe('derived data', () => {
    const seedDerived = async (container: string) => {
      await rootDb.query(
        `CREATE meta_model SET tenant = tenant:test, container = type::record('container', $c),
           scope = 'person', scope_id = 'someone@test.example', lens = 'methodology', status = 'confident',
           explanation = 'derived from the container', model = { organizing_concepts: ['secret topic'] },
           computed_at = time::now(), job_version = 't';
         CREATE training_run SET container = type::record('container', $c), status = 'completed',
           edge_count = 60, node_count = 10, dimensions = 20`,
        { c: container }
      );
    };

    it('a hard purge also removes the stored meta-models and training runs of that container, and only those', async () => {
      await seedContainer('c_purged', { firstDeletedDaysAgo: 40, deletedDaysAgo: 40 });
      await seedContainer('c_kept');
      await seedDerived('c_purged');
      await seedDerived('c_kept');

      const outcome = await purgeContainer(rootDb, 'c_purged', 'test');
      expect(outcome).not.toBe('skipped');

      const left = await queryAll<{ container: unknown }>(rootDb, `SELECT container FROM meta_model`);
      expect(left.map((r) => String(r.container))).toEqual(['container:c_kept']);
      const runs = await queryAll<{ container: unknown }>(rootDb, `SELECT container FROM training_run`);
      expect(runs.map((r) => String(r.container))).toEqual(['container:c_kept']);
    });

    it('a container that is not eligible keeps its derived data (the purge was skipped)', async () => {
      await seedContainer('c_active');
      await seedDerived('c_active');
      expect(await purgeContainer(rootDb, 'c_active', 'test')).toBe('skipped');
      expect(await queryAll(rootDb, `SELECT id FROM meta_model`)).toHaveLength(1);
      expect(await queryAll(rootDb, `SELECT id FROM training_run`)).toHaveLength(1);
    });
  });

  describe('CAP-1: eligibility window', () => {
    it('purges a container soft-deleted 31 days ago, leaves recent and active ones', async () => {
      await seedContainer('c_old', { firstDeletedDaysAgo: 31, deletedDaysAgo: 31 });
      await seedContainer('c_recent', { firstDeletedDaysAgo: 5, deletedDaysAgo: 5 });
      await seedContainer('c_active', {});

      const result = await runPurge(rootDb);

      expect(result.eligible).toBe(1);
      expect(result.purged).toHaveLength(1);
      expect(result.purged[0].container).toBe('c_old');
      expect(result.failures).toHaveLength(0);

      const remaining = await ids('container');
      expect(remaining.some((id) => id.includes('c_old'))).toBe(false);
      expect(remaining.some((id) => id.includes('c_recent'))).toBe(true);
      expect(remaining.some((id) => id.includes('c_active'))).toBe(true);
    });

    it('does not purge a restored container even with old first_deleted_at', async () => {
      // first deleted 31 days ago, then restored (deleted_at cleared)
      await seedContainer('c_restored', { firstDeletedDaysAgo: 31 });

      const result = await runPurge(rootDb);

      expect(result.eligible).toBe(0);
      expect(result.purged).toHaveLength(0);
      expect((await ids('container')).some((id) => id.includes('c_restored'))).toBe(true);
    });

    it('purges after delete → restore → delete: window keyed off first_deleted_at', async () => {
      // First deleted 31 days ago; re-deleted just yesterday. Restore must
      // not reset the purge timer.
      await seedContainer('c_cycled', { firstDeletedDaysAgo: 31, deletedDaysAgo: 1 });

      const result = await runPurge(rootDb);

      expect(result.purged.map((p) => p.container)).toEqual(['c_cycled']);
    });

    it('reports a clean heartbeat run when nothing is eligible', async () => {
      const result = await runPurge(rootDb);
      expect(result).toEqual({ eligible: 0, purged: [], skipped: [], failures: [] });
    });
  });

  describe('CAP-1: cascade and audit', () => {
    it('deletes nodes and ALL touching edges including cross-container, writes audit atomically', async () => {
      await seedContainer('c_old', { firstDeletedDaysAgo: 31, deletedDaysAgo: 31 });
      await seedContainer('c_keep', {});

      // granted relation rows must cascade with their container (and only theirs)
      await rootDb.query(
        `RELATE container:c_old->granted->principal:user_alice;
         RELATE container:c_keep->granted->principal:user_alice;`
      );

      await seedNode('n1', 'c_old');
      await seedNode('n2', 'c_old');
      await seedNode('n_keep', 'c_keep');
      await seedNode('n_free', null); // containerless

      await seedEdge('n1', 'n2'); // both in purged container
      await seedEdge('n1', 'n_keep'); // purged node as in
      await seedEdge('n_keep', 'n2'); // purged node as out
      await seedEdge('n_free', 'n1'); // purged node linked from containerless
      await seedEdge('n_keep', 'n_free'); // no purged endpoint — must survive

      const result = await runPurge(rootDb);

      expect(result.purged).toHaveLength(1);
      expect(result.purged[0].node_count).toBe(2);
      expect(result.purged[0].edge_count).toBe(4);

      const nodes = await ids('node');
      expect(nodes.some((id) => id.includes('n1') && !id.includes('n_keep'))).toBe(false);
      expect(nodes.some((id) => id.includes('n_keep'))).toBe(true);
      expect(nodes.some((id) => id.includes('n_free'))).toBe(true);

      // Edge ids are RELATE-generated, so identify the sole survivor by its
      // endpoints: exactly the n_keep -> n_free edge (no purged endpoint).
      // c_old's grant rows cascaded; c_keep's survive
      const grants = await queryAll<{ in: unknown }>(rootDb, `SELECT in FROM granted`);
      expect(grants).toHaveLength(1);
      expect(String(grants[0].in)).toContain('c_keep');

      const edges = await edgeEndpoints();
      expect(edges).toHaveLength(1);
      expect(edges[0].in).toBe('node:n_keep');
      expect(edges[0].out).toBe('node:n_free');

      const audits = await queryAll<{
        action: string;
        actor: string;
        tenant_id: string;
        container_id: string;
        node_count: number;
        edge_count: number;
        reason: string | null;
      }>(rootDb, `SELECT * FROM audit_log`);
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('container_purge');
      expect(audits[0].actor).toBe('purge-job');
      expect(audits[0].tenant_id).toBe('test');
      expect(audits[0].container_id).toBe('c_old');
      expect(audits[0].node_count).toBe(2);
      expect(audits[0].edge_count).toBe(4);
      expect(audits[0].reason ?? null).toBeNull();
    });

    it('purgeContainer skips (and deletes nothing) when the container was restored in between', async () => {
      await seedContainer('c_raced', { firstDeletedDaysAgo: 31 }); // deleted_at NONE = restored
      await seedNode('n1', 'c_raced');

      const outcome = await purgeContainer(rootDb, 'c_raced', 'test');

      expect(outcome).toBe('skipped');
      expect((await ids('container')).some((id) => id.includes('c_raced'))).toBe(true);
      expect(await ids('node')).toHaveLength(1);
      expect(await ids('audit_log')).toHaveLength(0);
    });

    it('second run purges nothing (idempotent)', async () => {
      await seedContainer('c_old', { firstDeletedDaysAgo: 31, deletedDaysAgo: 31 });

      const first = await runPurge(rootDb);
      expect(first.purged).toHaveLength(1);

      const second = await runPurge(rootDb);
      expect(second.eligible).toBe(0);
      expect(second.purged).toHaveLength(0);
      // audit trail from the first run is untouched
      expect(await ids('audit_log')).toHaveLength(1);
    });

    it('purges a default-convention container like any other (GDPR erasure)', async () => {
      await seedContainer('test_default', { firstDeletedDaysAgo: 31, deletedDaysAgo: 31 });

      const result = await runPurge(rootDb);

      expect(result.purged.map((p) => p.container)).toEqual(['test_default']);
    });
  });

  describe('CAP-2: admin soft-delete', () => {
    it('soft-deletes a container and writes the audit record with actor and reason', async () => {
      await seedContainer('c_target', {});

      const result = await adminSoftDelete(rootDb, {
        containerId: 'c_target',
        tenantId: 'test',
        actor: 'staff-user-42',
        reason: 'GDPR request #1234',
      });

      expect(result).not.toBe('not_found');
      if (result === 'not_found') return;
      expect(result.deleted_at).toBeTruthy();
      expect(result.first_deleted_at).toBeTruthy();

      const audits = await queryAll<{
        action: string;
        actor: string;
        tenant_id: string;
        container_id: string;
        reason: string;
        node_count: number | null;
      }>(rootDb, `SELECT * FROM audit_log`);
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('admin_soft_delete');
      expect(audits[0].actor).toBe('staff-user-42');
      expect(audits[0].tenant_id).toBe('test');
      expect(audits[0].container_id).toBe('c_target');
      expect(audits[0].reason).toBe('GDPR request #1234');
      expect(audits[0].node_count ?? null).toBeNull();

      // container is soft-deleted, not gone
      const containers = await queryAll<{ deleted_at: string | null }>(
        rootDb,
        `SELECT deleted_at FROM container WHERE name = 'c_target'`
      );
      expect(containers).toHaveLength(1);
      expect(containers[0].deleted_at).toBeTruthy();
    });

    it('returns not_found for a container in a different tenant, and rolls back the audit record', async () => {
      await seedContainer('c_other_tenant', { tenant: 'other' });

      const result = await adminSoftDelete(rootDb, {
        containerId: 'c_other_tenant',
        tenantId: 'test', // wrong tenant
        actor: 'staff-user-42',
        reason: 'GDPR request #1234',
      });

      expect(result).toBe('not_found');
      expect(await ids('audit_log')).toHaveLength(0);
    });

    it('is idempotent on an already-deleted container but still audits the action', async () => {
      await seedContainer('c_deleted', { firstDeletedDaysAgo: 3, deletedDaysAgo: 3 });

      const result = await adminSoftDelete(rootDb, {
        containerId: 'c_deleted',
        tenantId: 'test',
        actor: 'staff-user-42',
        reason: 'GDPR request #5678',
      });

      expect(result).not.toBe('not_found');
      if (result === 'not_found') return;

      // first_deleted_at NOT reset by the admin action
      const threeDaysAgo = Date.now() - 3 * DAY_MS;
      expect(
        Math.abs(new Date(result.first_deleted_at).getTime() - threeDaysAgo)
      ).toBeLessThan(60_000);

      // action documented even though nothing changed
      const audits = await queryAll<{ reason: string }>(rootDb, `SELECT reason FROM audit_log`);
      expect(audits).toHaveLength(1);
      expect(audits[0].reason).toBe('GDPR request #5678');
    });

    it('admin-deleted container becomes purge-eligible 30 days after first_deleted_at', async () => {
      await seedContainer('c_target', {});
      await adminSoftDelete(rootDb, {
        containerId: 'c_target',
        tenantId: 'test',
        actor: 'staff-user-42',
        reason: 'GDPR request #1234',
      });

      // not eligible now
      const now = await runPurge(rootDb);
      expect(now.eligible).toBe(0);

      // backdate first_deleted_at past the window: becomes eligible
      await rootDb.query(
        `UPDATE container SET first_deleted_at = type::datetime($ts) WHERE name = 'c_target'`,
        { ts: new Date(Date.now() - 31 * DAY_MS).toISOString() }
      );
      const later = await runPurge(rootDb);
      expect(later.purged.map((p) => p.container)).toEqual(['c_target']);
    });
  });

  describe('atomicity: forced mid-transaction failure rolls back everything', () => {
    // The single most load-bearing SPEC constraint: a partial purge is a GDPR
    // compliance failure. Force the LAST statement of the transaction (the
    // audit CREATE) to fail by tightening the action ASSERT, and verify the
    // deletes rolled back with it.
    const ORIGINAL_ACTION_FIELD = `DEFINE FIELD OVERWRITE action ON audit_log TYPE string
      ASSERT $value INSIDE ['container_purge', 'admin_soft_delete'] PERMISSIONS FULL;`;

    it('purge rolls back deletes when the audit write fails', async () => {
      await seedContainer('c_atomic', { firstDeletedDaysAgo: 31, deletedDaysAgo: 31 });
      await seedNode('n_atomic', 'c_atomic');
      await seedEdge('n_atomic', 'n_atomic');

      await rootDb.query(
        `DEFINE FIELD OVERWRITE action ON audit_log TYPE string
         ASSERT $value INSIDE ['nothing_valid'] PERMISSIONS FULL;`
      );
      try {
        await expect(purgeContainer(rootDb, 'c_atomic', 'test')).rejects.toThrow();

        // Nothing was deleted, nothing was audited — all or nothing.
        expect((await ids('container')).some((id) => id.includes('c_atomic'))).toBe(true);
        expect(await ids('node')).toHaveLength(1);
        expect(await ids('edge')).toHaveLength(1);
        expect(await ids('audit_log')).toHaveLength(0);
      } finally {
        await rootDb.query(ORIGINAL_ACTION_FIELD);
      }

      // With the schema restored, the same purge succeeds
      const outcome = await purgeContainer(rootDb, 'c_atomic', 'test');
      expect(outcome).not.toBe('skipped');
    });
  });

  describe('HTTP surface against the real database', () => {
    // The unit tests stub the DB and the other integration tests bypass HTTP —
    // this is where the two halves meet: real routes, real transactions.
    const SECRET = 'integration-test-purge-secret-32ch!';

    async function makeApp() {
      const { createAdminRoutes } = await import('../admin-routes.js');
      const { createRootConnection } = await import('../../db.js');
      const fakeAuth: MiddlewareHandler = async (c, next) => {
        c.set('claims', {
          sub: 'staff-user-http',
          tenantId: 'staff-tenant',
          projects: [],
          scope: 'kg:read kg:write',
          principals: [],
          tier: 'free',
          platformRole: 'admin',
        });
        await next();
      };
      return createAdminRoutes({
        createRootConnection,
        purgeJobSecret: SECRET,
        authMiddleware: fakeAuth,
      });
    }

    it('DELETE /tenants/:tenantId/containers/:containerId soft-deletes and audits', async () => {
      await seedContainer('c_http', {});
      const app = await makeApp();

      const res = await app.request('/tenants/test/containers/c_http', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'GDPR request #http-1' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
      // ISO-8601, not Date.toString() — response format matches tenant routes
      expect(body.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(body.purge_after).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const containers = await queryAll<{ deleted_at: string | null }>(
        rootDb,
        `SELECT deleted_at FROM container WHERE name = 'c_http'`
      );
      expect(containers[0]?.deleted_at).toBeTruthy();

      const audits = await queryAll<{ action: string; actor: string; reason: string }>(
        rootDb,
        `SELECT action, actor, reason FROM audit_log`
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: 'admin_soft_delete',
        actor: 'staff-user-http',
        reason: 'GDPR request #http-1',
      });
    });

    it('POST /purge with the secret purges eligible containers end-to-end', async () => {
      await seedContainer('c_http_old', { firstDeletedDaysAgo: 31, deletedDaysAgo: 31 });
      const app = await makeApp();

      const res = await app.request('/purge', {
        method: 'POST',
        headers: { Authorization: `Bearer ${SECRET}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.purged.map((p: { container: string }) => p.container)).toEqual(['c_http_old']);
      expect((await ids('container')).some((id) => id.includes('c_http_old'))).toBe(false);
    });
  });
});
