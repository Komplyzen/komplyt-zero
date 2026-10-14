/**
 * kg_auth_session must be row-scoped to the signed-in session.
 *
 * Migration 006 defined the table PERMISSIONS FOR select FULL, so any
 * signed-in tenant could read every other tenant's session row (tenantId,
 * principals, sub, scope, projects). These tests sign in through the real
 * `kg_server` access (standard factory, real migration chain) as two
 * tenants and assert neither can see the other's row.
 *
 * The suite runs through BOTH connection factories: `dbFactory` (a direct
 * connection, used by the stdio CLI) and `pooledDbFactory` (newSession +
 * signin on a shared WebSocket, the production HTTP path), because `$auth`
 * must resolve to the caller's own row on each.
 *
 * Queries are NOT wrapped in try/catch: a permission-denied statement returns
 * no rows rather than throwing, so any thrown error is a real failure (bad
 * query, dead connection) that must not pass as "returned nothing".
 *
 * Run with: bun run vitest run auth-session-isolation.integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { KgDbClient } from '../contracts.js';
import { dbFactory } from '../db.js';
import { pooledDbFactory, gracefulShutdown } from '../pool.js';
import type { DbFactory } from '../contracts.js';
import { connectTestDb, wipeData } from './connect.js';

let rootDb: Surreal;

interface SessionRow {
  id: unknown;
  tenantId: string;
  sub: string;
  principals: string[];
  projects: string[];
}

async function signIn(factory: DbFactory, sub: string, tenantId: string): Promise<KgDbClient> {
  return factory.createScoped({
    sub,
    tenantId,
    scope: 'kg:read kg:write',
    principals: [`principal:user_${sub}`, `principal:tenant_${tenantId}`],
    projects: [`project_${tenantId}`],
    tier: 'free',
  });
}

describe.each([
  ['direct connection', dbFactory],
  ['pooled session', pooledDbFactory],
] as const)('kg_auth_session tenant isolation via %s', (_label, factory) => {
  let skipTests = false;
  const q = <T>(db: KgDbClient, sql: string, vars?: Record<string, unknown>) => db.query<T>(sql, vars);
  let acme: KgDbClient;
  let acmeSecondSession: KgDbClient;
  let rival: KgDbClient;
  let rivalRowId: string;

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
    await rootDb.query(`CREATE tenant:acme SET name = 'Acme'; CREATE tenant:rival SET name = 'Rival';`);

    acme = await signIn(factory, 'alice', 'acme');
    acmeSecondSession = await signIn(factory, 'carol', 'acme');
    rival = await signIn(factory, 'bob', 'rival');

    const [rows] = await rootDb.query<[{ id: { toString(): string } }[]]>(
      `SELECT id FROM kg_auth_session WHERE tenantId = 'rival'`
    );
    rivalRowId = rows[0].id.toString();
  });

  afterAll(async () => {
    await acme?.close();
    await acmeSecondSession?.close();
    await rival?.close();
    await rootDb?.close();
    if (factory === pooledDbFactory) await gracefulShutdown();
  });

  describe('CAP-1: a tenant reads only its own session row', () => {
    it('table scan returns exactly the caller\'s own row', async () => {
      const rows = await q<SessionRow>(acme, 'SELECT tenantId, sub, principals, projects FROM kg_auth_session');
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe('acme');
      expect(rows[0].sub).toBe('alice');
    });

    it('does not expose another tenant\'s identity, principals or projects', async () => {
      const rows = await q<SessionRow>(acme, 'SELECT * FROM kg_auth_session');
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain('rival');
      expect(dump).not.toContain('bob');
    });

    it('record-id lookup of another tenant\'s row returns nothing', async () => {
      const rows = await q<SessionRow>(acme, `SELECT * FROM type::record($id)`, { id: rivalRowId });
      expect(rows).toHaveLength(0);
    });

    it('filtering by another tenant returns nothing', async () => {
      const rows = await q<SessionRow>(acme, `SELECT * FROM kg_auth_session WHERE tenantId = 'rival'`);
      expect(rows).toHaveLength(0);
    });

    it('count() sees one row, not the whole table', async () => {
      const rows = await q<{ count: number }>(acme, 'SELECT count() AS count FROM kg_auth_session GROUP ALL');
      expect(rows[0]?.count).toBe(1);
    });

    it('another session of the same tenant is also invisible', async () => {
      const rows = await q<SessionRow>(acme, `SELECT * FROM kg_auth_session WHERE sub = 'carol'`);
      expect(rows).toHaveLength(0);
      const own = await q<SessionRow>(acmeSecondSession, 'SELECT sub FROM kg_auth_session');
      expect(own.map((r) => r.sub)).toEqual(['carol']);
    });

    it('symmetric: the other tenant sees only its own row', async () => {
      const rows = await q<SessionRow>(rival, 'SELECT tenantId, sub FROM kg_auth_session');
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe('rival');
    });
  });

  describe('scoped users cannot write the table', () => {
    it('cannot rewrite another tenant\'s session row', async () => {
      await q(acme, `UPDATE type::record($id) SET tenantId = 'acme'`, { id: rivalRowId });
      const [rows] = await rootDb.query<[SessionRow[]]>(`SELECT tenantId FROM type::record($id)`, { id: rivalRowId });
      expect(rows[0].tenantId).toBe('rival');
    });

    it('cannot forge a session row', async () => {
      await q(
        acme,
        `CREATE kg_auth_session CONTENT { tenantId: 'rival', principals: [], sub: 'forged', scope: 'kg:write', projects: [] }`
      );
      const [rows] = await rootDb.query<[SessionRow[]]>(`SELECT sub FROM kg_auth_session WHERE sub = 'forged'`);
      expect(rows).toHaveLength(0);
    });
  });

  describe('CAP-2: $auth-based RLS elsewhere keeps working', () => {
    it('tenant table is still visible to its own tenant and only that one', async () => {
      const rows = await q<{ id: { toString(): string } }>(acme, 'SELECT id FROM tenant');
      expect(rows.map((r) => r.id.toString())).toEqual(['tenant:acme']);
    });
  });
});
