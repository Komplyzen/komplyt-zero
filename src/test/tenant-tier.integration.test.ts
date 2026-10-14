/**
 * The tenant's tier in the graph: the server notes the tier it sees in verified tokens so that
 * the private batch job can limit itself to licensed workspaces. It lives in its own table, tenant_tier
 * (migration 037), which no tenant can read or write.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { principalId, type KgTokenPayload } from '../contracts.js';
import { createRootConnection, dbFactory } from '../db.js';
import { checkTenantTierTable, createRootTierWriter } from '../tenant-tier.js';
import { connectTestDb, wipeData } from './connect.js';

let rootDb: Surreal;

interface Row {
  tier: string;
  updated_at: unknown;
  changed_at: unknown;
}
const tierRow = async (id: string): Promise<Row | undefined> =>
  (
    await rootDb.query<Array<Row[]>>(`SELECT tier, updated_at, changed_at FROM type::record('tenant_tier', $id)`, {
      id,
    })
  )[0][0];
const time = (v: unknown) => new Date(String(v)).getTime();

describe('tenant tier storage', () => {
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
    await rootDb.query('DELETE tenant_tier');
  });

  afterAll(async () => {
    await rootDb?.close();
  });

  const writer = () => createRootTierWriter(createRootConnection);

  it('writes a row keyed by the tenant id, and creates no tenant row', async () => {
    await writer().upsertTier('acme', 'team');
    const row = await tierRow('acme');
    expect(row?.tier).toBe('team');
    expect(row?.updated_at).toBeTruthy();
    expect(row?.changed_at).toBeTruthy();
    const tenants = await rootDb.query<Array<unknown[]>>(`SELECT * FROM tenant`);
    expect(tenants[0]).toHaveLength(0); // nothing the tools return (tenant.name) or index (tenant_name) is touched
  });

  it('same tier again: updated_at moves, changed_at does not', async () => {
    await writer().upsertTier('acme', 'team');
    const first = (await tierRow('acme'))!;
    await new Promise((r) => setTimeout(r, 20));
    await writer().upsertTier('acme', 'team');
    const second = (await tierRow('acme'))!;
    expect(time(second.updated_at)).toBeGreaterThan(time(first.updated_at));
    expect(time(second.changed_at)).toBe(time(first.changed_at));
  });

  it('a different tier moves both, and the row keeps one record per tenant', async () => {
    await writer().upsertTier('acme', 'team');
    const first = (await tierRow('acme'))!;
    await new Promise((r) => setTimeout(r, 20));
    await writer().upsertTier('acme', 'free');
    const second = (await tierRow('acme'))!;
    expect(second.tier).toBe('free');
    expect(time(second.changed_at)).toBeGreaterThan(time(first.changed_at));
    expect((await rootDb.query<Array<unknown[]>>(`SELECT * FROM tenant_tier`))[0]).toHaveLength(1);
  });

  it.each(['a-b', '123', 'ü-tenant', 'tenant with space', "o'brien"])('works for the tenant id %j', async (id) => {
    await writer().upsertTier(id, 'pro');
    expect((await tierRow(id))?.tier).toBe('pro');
  });

  it('the schema refuses an unknown tier', async () => {
    await expect(
      rootDb.query(`CREATE tenant_tier:bad SET tier = 'platinum', updated_at = time::now(), changed_at = time::now()`)
    ).rejects.toThrow();
  });

  it('a tenant can neither read nor write tiers: scoped connections see nothing and change nothing', async () => {
    await writer().upsertTier('acme', 'free');
    await writer().upsertTier('rival', 'enterprise');
    const claims: KgTokenPayload = {
      sub: 'u1',
      tenantId: 'acme',
      projects: [],
      scope: 'kg:read kg:write',
      principals: [principalId('User', 'u1'), principalId('Tenant', 'acme')],
      tier: 'free',
      platformRole: 'member',
    };
    const db = await dbFactory.createScoped(claims);
    try {
      const seen = await db.query<{ tier: string }>(`SELECT * FROM tenant_tier`);
      expect(seen).toEqual([]); // not even its own row, let alone another tenant's
      await db.query(`UPDATE tenant_tier:acme SET tier = 'enterprise'`);
      await db.query(
        `CREATE tenant_tier:mine SET tier = 'enterprise', updated_at = time::now(), changed_at = time::now()`
      );
      await db.query(`DELETE tenant_tier:rival`);
    } finally {
      await db.close();
    }
    expect((await tierRow('acme'))?.tier).toBe('free');
    expect(await tierRow('mine')).toBeUndefined();
    expect((await tierRow('rival'))?.tier).toBe('enterprise');
  });

  it('checkTenantTierTable is true on a migrated database', async () => {
    expect(await checkTenantTierTable(createRootConnection)).toBe(true);
  });
});
