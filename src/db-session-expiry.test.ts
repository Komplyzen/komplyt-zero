/**
 * A scoped connection must fail loudly once it is older than the window in
 * which its kg_auth_session row is guaranteed to exist; past that the row may
 * have been pruned and RLS-filtered reads would silently return nothing.
 * Uses a fake Surreal transport and an injected clock.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Surreal } from 'surrealdb';
import { createScopedClient, ScopedSessionExpiredError } from './db.js';

function fakeSurreal(): { db: Surreal; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => [[{ id: 'tenant:acme' }]]);
  return { db: { query, close: async () => {} } as unknown as Surreal, query };
}

describe('createScopedClient expiry guard', () => {
  it('serves queries while the client is younger than maxAgeMs', async () => {
    let t = 1_000_000;
    const { db } = fakeSurreal();
    const client = createScopedClient(db, { maxAgeMs: 60_000, now: () => t });
    t += 59_999;
    expect(await client.query('SELECT id FROM tenant')).toEqual([{ id: 'tenant:acme' }]);
  });

  it('throws ScopedSessionExpiredError once older, from query and queryOne, without touching the database', async () => {
    let t = 1_000_000;
    const { db, query } = fakeSurreal();
    const client = createScopedClient(db, { maxAgeMs: 60_000, now: () => t });
    t += 60_001;
    await expect(client.query('SELECT id FROM tenant')).rejects.toBeInstanceOf(ScopedSessionExpiredError);
    await expect(client.queryOne('SELECT id FROM tenant')).rejects.toBeInstanceOf(ScopedSessionExpiredError);
    expect(query).not.toHaveBeenCalled();
  });

  it('has no limit when maxAgeMs is undefined (pruning disabled)', async () => {
    let t = 0;
    const { db } = fakeSurreal();
    const client = createScopedClient(db, { now: () => t });
    t += 10 * 365 * 24 * 3600 * 1000;
    await expect(client.query('SELECT id FROM tenant')).resolves.toHaveLength(1);
  });

  it('still lets the caller close an expired client', async () => {
    let t = 0;
    const close = vi.fn(async () => {});
    const client = createScopedClient({ query: vi.fn(), close } as unknown as Surreal, { maxAgeMs: 1, now: () => t });
    t += 10;
    await client.close();
    expect(close).toHaveBeenCalled();
  });
});
