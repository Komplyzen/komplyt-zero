/**
 * Unit tests for connectTestDb's guard rails — the pieces that keep CI from
 * going vacuously green (KG_REQUIRE_DB) and local runs from wiping a real
 * database (KG_DB_NAME allowlist).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../env.js', () => ({
  getEnv: vi.fn(() => ({
    KG_DB_URL: 'ws://localhost:9999',
    KG_JWT_SECRET: 'unit-test-secret-at-least-32-characters!!',
    KG_DB_NAME: process.env.__TEST_DB_NAME ?? 'test',
  })),
}));
vi.mock('../db.js', () => ({
  createRootConnection: vi.fn(async () => {
    throw new Error('unreachable in these tests');
  }),
}));

import { createHash } from 'crypto';
import { createRootConnection } from '../db.js';
import { connectTestDb, wipeData } from './connect.js';

describe('connectTestDb guard rails', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env.KG_REQUIRE_DB;
    delete process.env.__TEST_DB_NAME;
    // Health probe fails fast in all these tests
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.KG_REQUIRE_DB;
    delete process.env.__TEST_DB_NAME;
  });

  it('returns null (graceful local skip) when the DB is unreachable', async () => {
    expect(await connectTestDb()).toBeNull();
  });

  it('throws when KG_REQUIRE_DB is set and the DB is unreachable — CI must never pass vacuously', async () => {
    process.env.KG_REQUIRE_DB = '1';
    await expect(connectTestDb()).rejects.toThrow(/KG_REQUIRE_DB/);
  });

  it('refuses non-test database names outright, even before probing', async () => {
    process.env.__TEST_DB_NAME = 'main';
    await expect(connectTestDb()).rejects.toThrow(/refuse/);

    process.env.__TEST_DB_NAME = 'staging';
    await expect(connectTestDb()).rejects.toThrow(/refuse/);
  });

  it('matches names exactly — prefix lookalikes are refused', async () => {
    for (const name of ['testing', 'test_prod', 'test-1', 'ci_', 'ci_prod.main', 'ci_1; DROP', 'ci-123', 'Test']) {
      process.env.__TEST_DB_NAME = name;
      await expect(connectTestDb()).rejects.toThrow(/refuse/);
    }
  });

  it('accepts test and ci_* database names', async () => {
    process.env.__TEST_DB_NAME = 'ci_12345_1';
    expect(await connectTestDb()).toBeNull(); // passes the guard, then skips on unreachable
  });
});

describe('connectTestDb allowlist overwrite', () => {
  const realFetch = globalThis.fetch;
  const queries: Array<{ sql: string; vars?: Record<string, unknown> }> = [];

  beforeEach(() => {
    queries.length = 0;
    delete process.env.KG_REQUIRE_DB;
    process.env.__TEST_DB_NAME = 'ci_42_1';
    globalThis.fetch = vi.fn(async () => new Response('ok')) as unknown as typeof fetch;
    mockConnection({ kg_config: 'DEFINE TABLE kg_config SCHEMAFULL' });
  });

  function mockConnection(tables: Record<string, string>) {
    vi.mocked(createRootConnection).mockResolvedValueOnce({
      query: async (sql: string, vars?: Record<string, unknown>) => {
        queries.push({ sql, vars });
        return sql.startsWith('INFO') ? [{ tables }] : [];
      },
      close: async () => {},
    } as never);
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.__TEST_DB_NAME;
  });

  it('overwrites kg_config:signin with exactly the env secret hash on a test database', async () => {
    const db = await connectTestDb();
    expect(db).not.toBeNull();
    const upserts = queries.filter((q) => q.sql.startsWith('UPSERT'));
    expect(upserts).toHaveLength(1);
    expect(upserts[0].sql).toMatch(/UPSERT kg_config:signin SET signin_sha256s = \[\$hash\]/);
    expect(upserts[0].vars).toEqual({
      hash: createHash('sha256').update('unit-test-secret-at-least-32-characters!!').digest('hex'),
    });
  });
});

describe('connectTestDb without the kg_config table', () => {
  const realFetch = globalThis.fetch;

  it('fails loudly and writes nothing when kg_config is not defined', async () => {
    process.env.__TEST_DB_NAME = 'test';
    globalThis.fetch = vi.fn(async () => new Response('ok')) as unknown as typeof fetch;
    const seen: string[] = [];
    vi.mocked(createRootConnection).mockResolvedValueOnce({
      query: async (sql: string) => {
        seen.push(sql);
        return sql.startsWith('INFO') ? [{ tables: {} }] : [];
      },
      close: async () => {},
    } as never);
    try {
      await expect(connectTestDb()).rejects.toThrow(/migrations applied\?/);
      expect(seen.some((s) => s.startsWith('UPSERT'))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.__TEST_DB_NAME;
    }
  });
});

describe('wipeData', () => {
  it('never touches kg_config — the signin allowlist outlives data wipes', async () => {
    let sql = '';
    await wipeData({ query: async (q: string) => void (sql = q) } as never);
    expect(sql).toMatch(/DELETE node/);
    expect(sql).not.toMatch(/kg_config/);
  });
});

