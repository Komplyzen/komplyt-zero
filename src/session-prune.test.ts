/**
 * Timing and failure behaviour of the kg_auth_session pruner, with fake timers
 * and a fake connection (acceptable per CLAUDE.md: the transport, not the
 * database). SQL semantics against a real SurrealDB are in
 * test/session-prune.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { pruneAuthSessions, startSessionPruner } from './session-prune.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface FakeDb {
  db: Surreal;
  query: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

/** Fake root connection. `deleted` is the row count each DELETE batch reports, in order; then 0. */
function fakeDb(deleted: Array<number | Error>, rowsLeft = 7): FakeDb {
  const queue = [...deleted];
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('count()')) return [[{ count: rowsLeft }]];
    const next = queue.shift() ?? 0;
    if (next instanceof Error) throw next;
    return [null, null, next];
  });
  const close = vi.fn(async () => {});
  return { db: { query, close } as unknown as Surreal, query, close };
}

describe('pruneAuthSessions (fake connection)', () => {
  it('reports the remaining row count after a completed run', async () => {
    const f = fakeDb([3], 42);
    expect(await pruneAuthSessions(f.db, DAY_MS, { batchSize: 10, pauseMs: 0 })).toEqual({
      removed: 3,
      capped: false,
      remaining: 42,
    });
  });

  it('omits the remaining count when the run was capped', async () => {
    const f = fakeDb([2, 2, 2], 42);
    const result = await pruneAuthSessions(f.db, DAY_MS, { batchSize: 2, maxBatches: 2, pauseMs: 0 });
    expect(result).toEqual({ removed: 4, capped: true });
  });

  it('retries a batch that hit a read/write conflict', async () => {
    const conflict = new Error(
      'Failed to commit transaction due to a read or write conflict. This transaction can be retried'
    );
    const f = fakeDb([conflict, conflict, 3]);
    const result = await pruneAuthSessions(f.db, DAY_MS, { batchSize: 10, pauseMs: 0 });
    expect(result.removed).toBe(3);
  });

  it('does not retry errors that merely mention "conflict" or are unrelated', async () => {
    const unrelated = new Error('index conflict in some other statement');
    const f = fakeDb([unrelated, 3]);
    await expect(pruneAuthSessions(f.db, DAY_MS, { batchSize: 10, pauseMs: 0 })).rejects.toThrow('index conflict');
    expect(f.query).toHaveBeenCalledTimes(1);
  });

  it('gives up on a conflict that never clears', async () => {
    const conflict = new Error('a read or write conflict. This transaction can be retried');
    const f = fakeDb([conflict, conflict, conflict, conflict, conflict]);
    await expect(pruneAuthSessions(f.db, DAY_MS, { batchSize: 10, pauseMs: 0 })).rejects.toThrow('conflict');
    expect(f.query).toHaveBeenCalledTimes(4); // first try + 3 retries
  });
});

describe('startSessionPruner (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const base = { initialDelayMs: 0, intervalMs: 60_000, maxAgeMs: DAY_MS, runTimeoutMs: 5_000, stopTimeoutMs: 1_000 };

  it('abandons a run whose connect never settles, reports it, and runs again next interval', async () => {
    let connects = 0;
    const failures: unknown[] = [];
    const ok = fakeDb([0]);
    const stop = startSessionPruner({
      ...base,
      connect: () => {
        connects++;
        return connects === 1 ? new Promise<Surreal>(() => {}) : Promise.resolve(ok.db);
      },
      onFailure: (e) => failures.push(e),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(connects).toBe(1);
    await vi.advanceTimersByTimeAsync(5_001); // run timeout
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toMatch(/timed out/);

    await vi.advanceTimersByTimeAsync(60_000); // next interval: not wedged
    expect(connects).toBe(2);
    expect(ok.query).toHaveBeenCalled();
    await stop();
  });

  it('closes a connection that arrives after its run was abandoned', async () => {
    const late = fakeDb([0]);
    let resolveConnect!: (db: Surreal) => void;
    const stop = startSessionPruner({
      ...base,
      connect: () => new Promise<Surreal>((resolve) => (resolveConnect = resolve)),
      onFailure: () => {},
    });
    await vi.advanceTimersByTimeAsync(5_001);
    resolveConnect(late.db);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.close).toHaveBeenCalled();
    expect(late.query).not.toHaveBeenCalled(); // never pruned on an abandoned run
    await stop();
  });

  it('stop() returns after stopTimeoutMs even when the run in flight is hung', async () => {
    const stop = startSessionPruner({ ...base, connect: () => new Promise<Surreal>(() => {}) });
    await vi.advanceTimersByTimeAsync(0);

    let returned = false;
    void stop().then(() => (returned = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(returned).toBe(true);
  });

  it('follows a capped run up after followUpDelayMs, not a whole interval later', async () => {
    const dbs = [fakeDb([2, 2]), fakeDb([0])];
    let n = 0;
    const runs: boolean[] = [];
    const stop = startSessionPruner({
      ...base,
      followUpDelayMs: 1_000,
      pruneOptions: { batchSize: 2, maxBatches: 2, pauseMs: 0 },
      connect: async () => dbs[n++].db,
      onRun: (r) => runs.push(r.capped),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toEqual([true]);
    await vi.advanceTimersByTimeAsync(1_001); // follow-up, far inside the 60s interval
    expect(runs).toEqual([true, false]);
    await stop();
  });

  it('stop() cancels a follow-up that is already scheduled', async () => {
    const f = fakeDb([2, 2]);
    let connects = 0;
    const stop = startSessionPruner({
      ...base,
      followUpDelayMs: 1_000,
      pruneOptions: { batchSize: 2, maxBatches: 2, pauseMs: 0 },
      connect: async () => {
        connects++;
        return f.db;
      },
    });
    await vi.advanceTimersByTimeAsync(0); // first run ends capped; follow-up now pending
    expect(connects).toBe(1);
    await stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connects).toBe(1);
  });
});
