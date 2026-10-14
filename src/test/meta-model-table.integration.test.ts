/**
 * Integration tests for the meta_model table.
 *
 * The computed meta-models (methodology, resiliency, process lenses) are data, not a request-time
 * computation: a private job fills this table and the public kg_meta_model tool only reads it.
 * The schema is public, so the table must enforce its own isolation:
 *   - a row is visible only to users who may see its container (same grant rule as node),
 *   - another tenant sees nothing,
 *   - a scoped (tenant) connection can never write; only the private job, signed in as root, does.
 *
 * Signs in through the real kg_server access (migrations); only the seed rows are test-local.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { principalId, type KgTokenPayload } from '../contracts.js';
import { dbFactory } from '../db.js';
import { connectTestDb, wipeData } from './connect.js';

let rootDb: Surreal;

const claimsFor = (tenantId: string, sub: string): KgTokenPayload => ({
  sub,
  tenantId,
  projects: [],
  scope: 'kg:read kg:write',
  principals: [principalId('User', sub), principalId('Tenant', tenantId)],
  tier: 'team',
  platformRole: 'member',
});

const row = (container: string, tenant: string, extra = '') =>
  `CREATE meta_model SET
     tenant = tenant:${tenant}, container = container:${container},
     scope = 'container', scope_id = '', lens = 'methodology',
     status = 'confident', explanation = 'e', model = { organizing_concepts: [] },
     computed_at = time::now(), job_version = 'test' ${extra};`;

async function visibleTo(claims: KgTokenPayload): Promise<string[]> {
  const db = await dbFactory.createScoped(claims);
  try {
    const rows = await db.query<{ container: unknown; scope: string; scope_id: string; lens: string }>(
      'SELECT container, scope, scope_id, lens FROM meta_model ORDER BY container, scope, scope_id, lens'
    );
    return rows.map((r) => `${String(r.container).replace(/^container:/, '')}/${r.scope}:${r.scope_id}/${r.lens}`);
  } finally {
    await db.close();
  }
}

describe('meta_model table (CAP-7)', () => {
  let skipTests = false;

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
  });

  beforeEach(async () => {
    if (skipTests) return;
    await wipeData(rootDb);
    await rootDb.query('DELETE meta_model');
    await rootDb.query(`
      CREATE tenant:acme SET name = 'Acme';
      CREATE tenant:rival SET name = 'Rival';
      CREATE principal:tenant_acme SET type = 'Tenant', ref_id = 'acme';
      CREATE principal:tenant_rival SET type = 'Tenant', ref_id = 'rival';
      CREATE principal:user_alice SET type = 'User', ref_id = 'alice';
      CREATE principal:user_bob SET type = 'User', ref_id = 'bob';
      CREATE principal:user_carol SET type = 'User', ref_id = 'carol';
      CREATE container:acme_default SET name = 'Company Knowledge', tenant = tenant:acme,
        owner = principal:tenant_acme, granted_principals = [principal:tenant_acme];
      CREATE container:acme_private SET name = 'Private', tenant = tenant:acme,
        owner = principal:user_alice, granted_principals = [principal:user_alice];
      CREATE container:rival_default SET name = 'Company Knowledge', tenant = tenant:rival,
        owner = principal:tenant_rival, granted_principals = [principal:tenant_rival];
    `);
    await rootDb.query(row('acme_default', 'acme'));
    await rootDb.query(row('acme_private', 'acme'));
    await rootDb.query(row('rival_default', 'rival'));
    await rootDb.query(
      `CREATE meta_model SET tenant = tenant:acme, container = container:acme_default,
         scope = 'project', scope_id = 'p1', lens = 'process',
         status = 'provisional', explanation = 'e', model = {}, computed_at = time::now(), job_version = 'test';`
    );
  });

  afterAll(async () => {
    await rootDb?.close();
  });

  it('a user sees the rows of every container they may see, in their own tenant', async () => {
    expect(await visibleTo(claimsFor('acme', 'alice'))).toEqual([
      'acme_default/container:/methodology',
      'acme_default/project:p1/process',
      'acme_private/container:/methodology',
    ]);
  });

  it('a container grant is respected: a tenant member without it does not see the private container', async () => {
    expect(await visibleTo(claimsFor('acme', 'bob'))).toEqual([
      'acme_default/container:/methodology',
      'acme_default/project:p1/process',
    ]);
  });

  it('another tenant sees only its own rows', async () => {
    expect(await visibleTo(claimsFor('rival', 'carol'))).toEqual(['rival_default/container:/methodology']);
  });

  it('a scoped connection cannot create, update or delete rows', async () => {
    const db = await dbFactory.createScoped(claimsFor('acme', 'alice'));
    try {
      await db.query(
        `CREATE meta_model SET tenant = tenant:acme, container = container:acme_default,
           scope = 'person', scope_id = 'x@acme.example', lens = 'resiliency',
           status = 'confident', explanation = 'forged', model = {}, computed_at = time::now(), job_version = 'forged'`
      );
      await db.query(`UPDATE meta_model SET explanation = 'tampered'`);
      await db.query(`DELETE meta_model`);
    } finally {
      await db.close();
    }
    const after = await rootDb.query<Array<Array<{ explanation: string; job_version: string }>>>(
      'SELECT explanation, job_version FROM meta_model'
    );
    expect(after[0]).toHaveLength(4);
    expect(after[0].every((r) => r.explanation !== 'tampered' && r.job_version !== 'forged')).toBe(true);
  });

  it('refuses a row whose tenant is not the tenant of its container', async () => {
    await expect(
      rootDb.query(
        `CREATE meta_model SET tenant = tenant:rival, container = container:acme_default,
           scope = 'container', scope_id = 'mismatch', lens = 'methodology', status = 'confident',
           explanation = 'e', model = {}, computed_at = time::now(), job_version = 't'`
      )
    ).rejects.toThrow();
    const rows = await rootDb.query<Array<Array<unknown>>>(`SELECT * FROM meta_model WHERE scope_id = 'mismatch'`);
    expect(rows[0]).toHaveLength(0);
  });

  it('a tenant listed in another tenant\'s container grants still sees nothing of it', async () => {
    // rival's tenant principal is (wrongly) granted on acme's container: the row's tenant still decides
    await rootDb.query(`UPDATE container:acme_default SET granted_principals += principal:tenant_rival`);
    expect(await visibleTo(claimsFor('rival', 'carol'))).toEqual(['rival_default/container:/methodology']);
  });

  it('is unique per container, scope, scope id and lens', async () => {
    await expect(rootDb.query(row('acme_default', 'acme'))).rejects.toThrow(/already contains|index/i);
  });

  it('rejects an unknown lens, scope or status', async () => {
    const bad = (field: string, value: string) =>
      rootDb.query(
        `CREATE meta_model SET tenant = tenant:acme, container = container:acme_default,
           scope = 'container', scope_id = 'u-${field}', lens = 'methodology', status = 'confident',
           explanation = 'e', model = {}, computed_at = time::now(), job_version = 't', ${field} = '${value}'`
      );
    await expect(bad('lens', 'bogus')).rejects.toThrow();
    await expect(bad('scope', 'galaxy')).rejects.toThrow();
    await expect(bad('status', 'maybe')).rejects.toThrow();
  });

  it('stores the model JSON as given, nested arrays and objects included', async () => {
    const model = { organizing_concepts: [{ id: 'n1', children: [1, 2, { deep: ['x'] }] }], nodes_analyzed: 3 };
    await rootDb.query(
      `CREATE meta_model SET tenant = tenant:acme, container = container:acme_default,
         scope = 'person', scope_id = 'a@acme.example', lens = 'methodology', status = 'confident',
         explanation = 'e', model = $model, computed_at = time::now(), job_version = 't'`,
      { model }
    );
    const got = await rootDb.query<Array<Array<{ model: unknown }>>>(
      `SELECT model FROM meta_model WHERE scope = 'person' AND scope_id = 'a@acme.example'`
    );
    expect(got[0][0].model).toEqual(model);
  });

  it('allows a null model for an insufficient result', async () => {
    await rootDb.query(
      `CREATE meta_model SET tenant = tenant:acme, container = container:acme_default,
         scope = 'person', scope_id = 'none@acme.example', lens = 'process', status = 'insufficient',
         explanation = 'not enough', computed_at = time::now(), job_version = 't'`
    );
    const got = await rootDb.query<Array<Array<{ status: string }>>>(
      `SELECT status FROM meta_model WHERE scope_id = 'none@acme.example'`
    );
    expect(got[0][0].status).toBe('insufficient');
  });
});
