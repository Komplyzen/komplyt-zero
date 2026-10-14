/**
 * kg_auth_session pruning. Every scoped request signs in and SIGNIN CREATEs a
 * session row; nothing deleted them. These tests sign in through the real
 * `kg_server` access, backdate rows as root (the only way to age a row without
 * waiting), and assert the pruner removes old rows and nothing else. The batch
 * tests need many aged rows but do not test SIGNIN, so they seed them as root in
 * one query: one sign-in per row is a round trip each to the remote CI database.
 *
 * Run with: bun run vitest run session-prune.integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { KgDbClient } from '../contracts.js';
import { dbFactory, createRootConnection } from '../db.js';
import { pruneAuthSessions, startSessionPruner } from '../session-prune.js';
import { connectTestDb, wipeData } from './connect.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
let rootDb: Surreal;

async function signIn(sub: string): Promise<KgDbClient> {
  return dbFactory.createScoped({
    sub,
    tenantId: 'acme',
    scope: 'kg:read kg:write',
    principals: [`principal:user_${sub}`],
    projects: [],
    tier: 'free',
  });
}

async function backdate(sub: string, hours: number): Promise<void> {
  await rootDb.query(`UPDATE kg_auth_session SET created_at = time::now() - type::duration($d) WHERE sub = $sub`, {
    d: `${hours}h`,
    sub,
  });
}

/** Aged session rows written as root in one query (same shape SIGNIN writes). */
async function seedAged(subs: string[], hours: number): Promise<void> {
  await rootDb.query(
    `FOR $sub IN $subs {
      CREATE kg_auth_session SET sub = $sub, tenantId = 'acme', scope = 'kg:read kg:write',
        principals = [string::concat('principal:user_', $sub)], projects = [],
        created_at = time::now() - type::duration($d);
    }`,
    { subs, d: `${hours}h` },
  );
}

async function subs(): Promise<string[]> {
  const [rows] = await rootDb.query<[{ sub: string }[]]>('SELECT sub FROM kg_auth_session ORDER BY sub');
  return rows.map((r) => r.sub);
}

describe('kg_auth_session pruning', () => {
  let skipTests = false;
  let open: KgDbClient[] = [];

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
    await rootDb.query(`CREATE tenant:acme SET name = 'Acme'`);
  });

  afterEach(async () => {
    await Promise.all(open.map((c) => c.close()));
    open = [];
  });

  afterAll(async () => {
    await rootDb?.close();
  });

  async function session(sub: string): Promise<KgDbClient> {
    const c = await signIn(sub);
    open.push(c);
    return c;
  }

  it('SIGNIN stamps created_at on new rows', async () => {
    await session('fresh');
    const [rows] = await rootDb.query<[{ created_at: Date }[]]>('SELECT created_at FROM kg_auth_session');
    expect(rows).toHaveLength(1);
    expect(Math.abs(new Date(rows[0].created_at).getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('the migration chain leaves no index on kg_auth_session (SIGNIN is the hottest write path)', async () => {
    const [info] = await rootDb.query<[{ indexes: Record<string, string> }]>('INFO FOR TABLE kg_auth_session');
    expect(info.indexes).toEqual({});
  });

  describe('pruneAuthSessions', () => {
    it('deletes rows older than the cutoff and keeps newer ones', async () => {
      await session('old');
      await session('borderline');
      await session('fresh');
      await backdate('old', 48);
      await backdate('borderline', 23);

      const result = await pruneAuthSessions(rootDb, DAY_MS);

      expect(result).toEqual({ removed: 1, capped: false, remaining: 2 });
      expect(await subs()).toEqual(['borderline', 'fresh']);
    });

    it('is a no-op when nothing is old, and reports zero', async () => {
      await session('fresh');
      expect(await pruneAuthSessions(rootDb, DAY_MS)).toEqual({ removed: 0, capped: false, remaining: 1 });
      expect(await subs()).toEqual(['fresh']);
    });

    it('works through more than one batch', async () => {
      await seedAged(['s0', 's1', 's2', 's3', 's4'], 48);
      await session('fresh');

      const result = await pruneAuthSessions(rootDb, DAY_MS, { batchSize: 2, pauseMs: 0 });

      expect(result).toEqual({ removed: 5, capped: false, remaining: 1 });
      expect(await subs()).toEqual(['fresh']);
    });

    it('stops at maxBatches, reports capped, and the next run finishes the backlog', async () => {
      await seedAged(['s0', 's1', 's2', 's3', 's4'], 48);

      const first = await pruneAuthSessions(rootDb, DAY_MS, { batchSize: 2, maxBatches: 2, pauseMs: 0 });
      expect(first).toEqual({ removed: 4, capped: true });
      expect(await subs()).toHaveLength(1);

      const second = await pruneAuthSessions(rootDb, DAY_MS, { batchSize: 2, maxBatches: 2, pauseMs: 0 });
      expect(second).toEqual({ removed: 1, capped: false, remaining: 0 });
      expect(await subs()).toEqual([]);
    });

    it('checks shouldStop between batches and ends the run early', async () => {
      await seedAged(['s0', 's1', 's2', 's3', 's4', 's5'], 48);

      let batches = 0;
      const result = await pruneAuthSessions(rootDb, DAY_MS, {
        batchSize: 2,
        pauseMs: 0,
        shouldStop: () => batches++ >= 1, // allow exactly one batch
      });

      expect(result).toEqual({ removed: 2, capped: false }); // stopped early: no count
      expect(await subs()).toHaveLength(4);
    });
  });

  describe('startSessionPruner', () => {
    const noJitter = { initialDelayMs: 0, intervalMs: 20, maxAgeMs: DAY_MS, pruneOptions: { pauseMs: 0 } };

    it('prunes old rows on its interval and reports each run', async () => {
      await session('old');
      await backdate('old', 48);
      const runs: number[] = [];

      const stop = startSessionPruner({ ...noJitter, connect: createRootConnection, onRun: (r) => runs.push(r.removed) });
      try {
        await expect.poll(async () => (await subs()).includes('old'), { timeout: 20_000, interval: 25 }).toBe(false);
        await expect.poll(() => runs.reduce((a, b) => a + b, 0), { timeout: 20_000, interval: 25 }).toBe(1);
      } finally {
        await stop();
      }
    });

    it('survives a failed run, reports it, and succeeds on the next interval', async () => {
      await session('old');
      await backdate('old', 48);
      let attempts = 0;
      let failures = 0;

      const stop = startSessionPruner({
        ...noJitter,
        connect: async () => {
          if (attempts++ === 0) throw new Error('connect refused');
          return createRootConnection();
        },
        onFailure: () => failures++,
      });
      try {
        await expect.poll(async () => (await subs()).includes('old'), { timeout: 20_000, interval: 25 }).toBe(false);
        expect(failures).toBe(1);
      } finally {
        await stop();
      }
    });

    it('stop() waits for the run in flight, which ends before another batch, and nothing runs after it returns', async () => {
      await session('old');
      await backdate('old', 48);
      let connects = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));

      const stop = startSessionPruner({
        ...noJitter,
        connect: async () => {
          connects++;
          await gate; // hold the first run open
          return createRootConnection();
        },
      });
      await expect.poll(() => connects, { timeout: 20_000, interval: 10 }).toBe(1);

      const stopped = stop();
      let resolved = false;
      void stopped.then(() => (resolved = true));
      await Promise.resolve();
      await Promise.resolve();
      expect(resolved).toBe(false); // still waiting on the in-flight run

      release();
      await stopped;
      // Stop was requested while the run was connecting, so it ended at its
      // first shouldStop check instead of starting a batch.
      expect(await subs()).toContain('old');

      // After stop returned the pruner is silent: further connects would have
      // been issued by the 20ms interval within this window.
      const after = connects;
      await expect.poll(() => connects, { timeout: 200, interval: 50 }).toBe(after).catch(() => {});
      expect(connects).toBe(after);
    });
  });
});
