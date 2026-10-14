import { describe, it, expect, vi } from 'vitest';
import type { Surreal } from 'surrealdb';
import {
  checkTenantTierTable,
  createRootTierWriter,
  createTenantTierRecorder,
  installTenantTierRecorder,
  noteTenantTier,
} from './tenant-tier.js';

const HOUR = 3_600_000;

function setup(opts: { hang?: boolean } = {}) {
  let clock = 1_000_000;
  const written: Array<{ tenantId: string; tier: string }> = [];
  let failNext = 0;
  const writer = {
    upsertTier: vi.fn(async (tenantId: string, tier: string) => {
      if (opts.hang) return new Promise<void>(() => {});
      if (failNext > 0) {
        failNext -= 1;
        throw new Error('database unavailable');
      }
      written.push({ tenantId, tier });
    }),
  };
  const recorder = createTenantTierRecorder(writer, { ttlMs: HOUR, now: () => clock });
  return {
    recorder,
    writer,
    written,
    advance: (ms: number) => (clock += ms),
    failNext: (n: number) => (failNext = n),
    settle: () => new Promise((r) => setTimeout(r, 0)),
    tiers: (tenantId = 'acme') => written.filter((w) => w.tenantId === tenantId).map((w) => w.tier),
  };
}

describe('tenant tier recorder', () => {
  it('writes the first sighting of a tenant at once', async () => {
    const t = setup();
    t.recorder.note('acme', 'team');
    await t.settle();
    expect(t.written).toEqual([{ tenantId: 'acme', tier: 'team' }]);
  });

  it('does not write again for the same tier within the window, however many requests', async () => {
    const t = setup();
    for (let i = 0; i < 50; i++) t.recorder.note('acme', 'team');
    await t.settle();
    t.advance(HOUR - 1);
    t.recorder.note('acme', 'team');
    await t.settle();
    expect(t.writer.upsertTier).toHaveBeenCalledTimes(1);
  });

  it('refreshes "last seen" once the window has passed', async () => {
    const t = setup();
    t.recorder.note('acme', 'team');
    await t.settle();
    t.advance(HOUR + 1);
    t.recorder.note('acme', 'team');
    await t.settle();
    expect(t.tiers()).toEqual(['team', 'team']);
  });

  it('an upgrade is written at once', async () => {
    const t = setup();
    t.recorder.note('acme', 'free');
    await t.settle();
    t.recorder.note('acme', 'enterprise');
    await t.settle();
    expect(t.tiers()).toEqual(['free', 'enterprise']);
  });

  it('a downgrade needs a whole window in which no higher tier was seen', async () => {
    const t = setup();
    t.recorder.note('acme', 'team');
    await t.settle();
    t.recorder.note('acme', 'free'); // a stale token or a free member of the team: not a downgrade
    await t.settle();
    expect(t.tiers()).toEqual(['team']);

    t.advance(HOUR + 1); // the window closes with team as its highest tier
    t.recorder.note('acme', 'free');
    await t.settle();
    expect(t.tiers()).toEqual(['team', 'team']);

    t.advance(HOUR + 1); // now a whole window saw only free
    t.recorder.note('acme', 'free');
    await t.settle();
    expect(t.tiers()).toEqual(['team', 'team', 'free']);
  });

  it('alternating tiers cannot drive unbounded writes or flap the stored tier', async () => {
    const t = setup();
    for (let i = 0; i < 200; i++) {
      t.recorder.note('acme', i % 2 === 0 ? 'team' : 'free');
      await t.settle();
    }
    expect(t.tiers()).toEqual(['team']); // one write, and it is the paid tier
    t.advance(HOUR + 1);
    t.recorder.note('acme', 'free');
    await t.settle();
    expect(t.tiers()).toEqual(['team', 'team']);
  });

  it('tenants are tracked separately', async () => {
    const t = setup();
    t.recorder.note('acme', 'team');
    t.recorder.note('beta', 'pro');
    await t.settle();
    expect(t.written.map((w) => `${w.tenantId}:${w.tier}`).sort()).toEqual(['acme:team', 'beta:pro']);
  });

  it('a request that arrives while the write is in flight does not start a second write', async () => {
    const t = setup();
    t.recorder.note('acme', 'team');
    t.recorder.note('acme', 'team');
    t.recorder.note('acme', 'team');
    await t.settle();
    expect(t.writer.upsertTier).toHaveBeenCalledTimes(1);
  });

  it('a failed write never throws into the caller and is retried on the next sighting', async () => {
    const t = setup();
    t.failNext(1);
    expect(() => t.recorder.note('acme', 'team')).not.toThrow();
    await t.settle();
    expect(t.written).toEqual([]);
    t.recorder.note('acme', 'team'); // no waiting for the window: the failure was not remembered as done
    await t.settle();
    expect(t.written).toEqual([{ tenantId: 'acme', tier: 'team' }]);
  });

  it('a write that never returns does not block the caller, and is given up on after its timeout', async () => {
    let clock = 0;
    const hung = { upsertTier: vi.fn(() => new Promise<void>(() => {})) };
    const recorder = createTenantTierRecorder(hung, { ttlMs: HOUR, now: () => clock, writeTimeoutMs: 20 });
    recorder.note('acme', 'team');
    await new Promise((r) => setTimeout(r, 60));
    clock += 1; // well within the window: only the failed write's retry marker can trigger another try
    recorder.note('acme', 'team');
    await new Promise((r) => setTimeout(r, 5));
    expect(hung.upsertTier).toHaveBeenCalledTimes(2);
  });

  it.each(['platinum', '', 'TEAM'])('ignores the tier %j that the schema would reject', async (tier) => {
    const t = setup();
    t.recorder.note('acme', tier);
    await t.settle();
    expect(t.writer.upsertTier).not.toHaveBeenCalled();
  });

  it('ignores an empty tenant id, and accepts ids with hyphens, digits and non-ASCII letters', async () => {
    const t = setup();
    t.recorder.note('', 'team');
    for (const id of ['a-b', '123', 'ü-tenant', 'x_y']) t.recorder.note(id, 'team');
    await t.settle();
    expect(t.written.map((w) => w.tenantId).sort()).toEqual(['123', 'a-b', 'x_y', 'ü-tenant']);
  });

  it('bounds its memory: a flood of distinct tenants does not grow without limit', async () => {
    const t = setup();
    const small = createTenantTierRecorder(t.writer, { ttlMs: HOUR, now: () => 0, maxTenants: 100 });
    for (let i = 0; i < 1000; i++) small.note(`t${i}`, 'team');
    await t.settle();
    expect(small.size()).toBeLessThanOrEqual(100);
  });
});

describe('the installed recorder', () => {
  it('noteTenantTier does nothing until a recorder is installed, then forwards', async () => {
    expect(() => noteTenantTier('acme', 'team')).not.toThrow();
    const t = setup();
    installTenantTierRecorder(t.recorder);
    noteTenantTier('acme', 'team');
    await t.settle();
    expect(t.written).toEqual([{ tenantId: 'acme', tier: 'team' }]);
    installTenantTierRecorder(null);
  });
});

describe('the root connection behind the writer', () => {
  const fakeDb = (overrides: Partial<Record<'query' | 'close', unknown>> = {}) =>
    ({ query: vi.fn(async () => []), close: vi.fn(async () => {}), ...overrides }) as unknown as Surreal;

  it('opens a connection per write and closes it afterwards', async () => {
    const first = fakeDb();
    const second = fakeDb();
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const writer = createRootTierWriter(connect);
    await writer.upsertTier('acme', 'team');
    await writer.upsertTier('acme', 'enterprise');
    expect(connect).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it('a failed write closes its connection and the next write opens a fresh one', async () => {
    const first = fakeDb({ query: vi.fn(async () => Promise.reject(new Error('socket closed'))) });
    const second = fakeDb();
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const writer = createRootTierWriter(connect, { timeoutMs: 1000 });

    await expect(writer.upsertTier('acme', 'team')).rejects.toThrow('socket closed');
    expect(first.close).toHaveBeenCalledTimes(1);
    await writer.upsertTier('acme', 'team');
    expect(second.query).toHaveBeenCalledTimes(1);
  });

  it('a query that hangs times out, and its connection is closed', async () => {
    const hung = fakeDb({ query: vi.fn(() => new Promise(() => {})) });
    const writer = createRootTierWriter(async () => hung, { timeoutMs: 20 });
    await expect(writer.upsertTier('acme', 'team')).rejects.toThrow(/timed out/i);
    expect(hung.close).toHaveBeenCalledTimes(1);
  });

  it('a connect that hangs times out too', async () => {
    const writer = createRootTierWriter(() => new Promise<Surreal>(() => {}), { timeoutMs: 20 });
    await expect(writer.upsertTier('acme', 'team')).rejects.toThrow(/timed out/i);
  });

  it('a failure to connect does not poison later attempts', async () => {
    const db = fakeDb();
    const connect = vi.fn().mockRejectedValueOnce(new Error('refused')).mockResolvedValueOnce(db);
    const writer = createRootTierWriter(connect);
    await expect(writer.upsertTier('acme', 'team')).rejects.toThrow('refused');
    await expect(writer.upsertTier('acme', 'team')).resolves.toBeUndefined();
  });
});

describe('checkTenantTierTable', () => {
  const dbThat = (query: () => Promise<unknown>) => ({ query, close: async () => {} }) as unknown as Surreal;

  it('is true when the table can be read, and closes the connection', async () => {
    const db = { query: async () => [[]], close: vi.fn(async () => {}) } as unknown as Surreal;
    expect(await checkTenantTierTable(async () => db)).toBe(true);
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it('is false, without throwing, when migration 037 is not applied', async () => {
    const missing = dbThat(async () => Promise.reject(new Error("The table 'tenant_tier' does not exist")));
    expect(await checkTenantTierTable(async () => missing)).toBe(false);
  });

  it('is false, without throwing, when the database cannot be reached', async () => {
    expect(await checkTenantTierTable(async () => Promise.reject(new Error('refused')))).toBe(false);
  });
});
