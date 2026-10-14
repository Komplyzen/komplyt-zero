/**
 * The stdio MCP server is a long-lived process, but a scoped DB session is
 * not: its kg_auth_session row is pruned after the retention window, and a
 * connection held past that sees empty results with no error (PR #135
 * adversarial review). executeStdioToolCallScoped signs in per call, so a
 * server process outliving the window keeps working.
 *
 * Run with: bun run vitest run stdio-scoped.integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { z } from 'zod';
import type { DbFactory, KgDbClient, KgTokenPayload, ToolHandler } from '../contracts.js';
import { Surreal } from 'surrealdb';
import { dbFactory } from '../db.js';
import { pooledDbFactory, gracefulShutdown } from '../pool.js';
import { getEnv } from '../env.js';
import { pruneAuthSessions } from '../session-prune.js';
import { executeStdioToolCallScoped } from '../bin/stdio-tool-call.js';
import { connectTestDb, wipeData } from './connect.js';

const DAY_MS = 24 * 60 * 60 * 1000;
let rootDb: Surreal;

const claims: KgTokenPayload = {
  sub: 'stdio_user',
  tenantId: 'acme',
  scope: 'kg:read',
  principals: ['principal:user_stdio_user'],
  projects: [],
  tier: 'free',
};

/** A tool whose result is whatever RLS lets the scoped connection see. */
const visibleTenants: ToolHandler<unknown> = {
  name: 'kg_status',
  description: 'test',
  requiredScope: 'kg:read',
  inputSchema: z.object({}),
  async execute(db: KgDbClient) {
    const rows = await db.query<{ id: { toString(): string } }>('SELECT id FROM tenant');
    return { content: [{ type: 'text' as const, text: JSON.stringify(rows.map((r) => r.id.toString())) }] };
  },
} as unknown as ToolHandler<unknown>;

const registry = { get: () => visibleTenants };
const embed = { embedDocuments: async () => [], embedQuery: async () => [], model: 'test-mock', dimensions: 0 };

async function ageAllSessionsAndPrune(): Promise<void> {
  await rootDb.query(`UPDATE kg_auth_session SET created_at = time::now() - 48h`);
  await pruneAuthSessions(rootDb, DAY_MS);
}

describe('stdio per-call sign-in', () => {
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
    await wipeData(rootDb);
    await rootDb.query(`CREATE tenant:acme SET name = 'Acme'; CREATE tenant:rival SET name = 'Rival'`);
  });

  afterAll(async () => {
    await rootDb?.close();
    await gracefulShutdown();
  });

  it.each([
    ['direct connection', dbFactory],
    ['pooled session (what the CLI uses)', pooledDbFactory],
  ] as const)('a call after the retention window still sees its tenant via %s', async (_label, factory) => {
    const run = () => executeStdioToolCallScoped({ registry, dbFactory: factory, embed, claims }, 'kg_status', {}, null);

    expect((await run()).content[0].text).toBe('["tenant:acme"]');
    await ageAllSessionsAndPrune();
    expect((await run()).content[0].text).toBe('["tenant:acme"]');
  });

  it('opens one connection per call and closes it, even when the tool throws', async () => {
    let opened = 0;
    let closed = 0;
    const counting: DbFactory = {
      async createScoped(c, signal) {
        opened++;
        const db = await dbFactory.createScoped(c, signal);
        return {
          ...db,
          close: async () => {
            closed++;
            await db.close();
          },
        };
      },
    };
    const boom = { get: () => ({ ...visibleTenants, execute: async () => { throw new Error('tool failed'); } }) as unknown as ToolHandler<unknown> };

    await executeStdioToolCallScoped({ registry, dbFactory: counting, embed, claims }, 'kg_status', {}, null);
    await expect(
      executeStdioToolCallScoped({ registry: boom, dbFactory: counting, embed, claims }, 'kg_status', {}, null)
    ).rejects.toThrow('tool failed');

    expect({ opened, closed }).toEqual({ opened: 2, closed: 2 });
  });

  it('documents the hazard the age guard exists for: a raw signed-in session goes silently empty once its row is pruned', async () => {
    const env = getEnv();
    const raw = new Surreal();
    await raw.connect(env.KG_DB_URL);
    try {
      await raw.signin({
        namespace: env.KG_DB_NS,
        database: env.KG_DB_NAME,
        access: 'kg_server',
        variables: { secret: env.KG_JWT_SECRET, ...claims },
      });
      await raw.use({ namespace: env.KG_DB_NS, database: env.KG_DB_NAME });
      const [before] = await raw.query<[unknown[]]>('SELECT id FROM tenant');
      expect(before).toHaveLength(1);

      await ageAllSessionsAndPrune();

      // No error, just empty: the DB gives no signal. ScopedSessionExpiredError
      // (db.ts, covered in db-session-expiry.test.ts) is what makes this loud.
      const [after] = await raw.query<[unknown[]]>('SELECT id FROM tenant');
      expect(after).toEqual([]);
    } finally {
      await raw.close();
    }
  });
});
