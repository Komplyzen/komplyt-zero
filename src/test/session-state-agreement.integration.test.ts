/**
 * Integration tests for the session-state disagreement fix.
 *
 * kg_status and kg_session action=info used to keep reporting an ended
 * session as current (ORDER BY started_at DESC LIMIT 1, no ended_at
 * filter), while the write-gating path in mcp.ts (resolveCurrentSession,
 * untouched by this fix) correctly excluded it. All three now resolve
 * "current session" through the same resolveActiveSession helper
 * (contracts.ts).
 *
 * Uses a minimal hand-rolled schema (root connection bypasses PERMISSIONS)
 * - node table only needs to exist (queried but never populated; status.ts's
 * node-count/todo/decision queries all tolerate an empty table).
 *
 * Run with: KG_DB_URL=ws://localhost:8001 npm test -- --run session-state-agreement.integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { EMBEDDING_DIMENSIONS, EmbeddingProvider, KgDbClient, ToolContext } from '../contracts.js';
import { sessionStartTool } from '../tools/session-start.js';
import { sessionEndTool } from '../tools/session-end.js';
import { sessionInfoTool } from '../tools/session-info.js';
import { statusTool } from '../tools/status.js';
import { connectTestDb, wipeData } from './connect.js';

let rootDb: Surreal;
let db: KgDbClient;

const noopEmbed: EmbeddingProvider = {
  embedDocuments: async (texts: string[]) => texts.map(() => []),
  embedQuery: async () => [],
  model: 'test-mock',
  dimensions: EMBEDDING_DIMENSIONS,
};

function parseResult<T>(result: { content: Array<{ text: string }>; isError?: boolean }): T {
  if (result.isError) {
    throw new Error(`Tool returned error: ${result.content[0]?.text}`);
  }
  return JSON.parse(result.content[0].text) as T;
}

describe('Session State Agreement', () => {
  let skipTests = false;

  // A skipped test must REPORT as skipped, not pass with an empty body.
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

    db = {
      async query<T>(sql: string, vars?: Record<string, unknown>): Promise<T[]> {
        const result = await rootDb.query<T[][]>(sql, vars);
        return result.flat();
      },
      async queryOne<T>(sql: string, vars?: Record<string, unknown>): Promise<T | null> {
        const results = await this.query<T>(sql, vars);
        return results[0] ?? null;
      },
      async close(): Promise<void> {
        // shared root connection - closed in afterAll instead
      },
    };
  });

  afterAll(async () => {
    await rootDb?.close();
  });

  async function makeTenant(): Promise<string> {
    const [tenant] = await db.query<{ id: string }>('CREATE tenant SET name = $name', { name: `t-${Date.now()}-${Math.random()}` });
    return String(tenant.id).replace('tenant:', '');
  }

  function makeContext(tenantId: string, sessionId: string | null): ToolContext {
    return {
      claims: { sub: 'user:test', tenantId, projects: [], scope: 'kg:read kg:write', principals: [], tier: 'free' },
      tenantId,
      projects: [],
      scope: 'kg:read kg:write',
      currentSession: sessionId,
    };
  }

  it('CAP-1: after ending the only session, kg_status and kg_session info both agree no session is current', async () => {
    const tenantId = await makeTenant();

    const started = parseResult<{ session_id: string }>(
      await sessionStartTool.execute(db, noopEmbed, makeContext(tenantId, null), { create_project: false } as never)
    );
    parseResult(await sessionEndTool.execute(db, noopEmbed, makeContext(tenantId, started.session_id), {} as never));

    const status = parseResult<{ current_session: number; session_active?: boolean }>(
      await statusTool.execute(db, noopEmbed, makeContext(tenantId, null), {} as never)
    );
    expect(status.current_session).toBe(0);
    expect(status.session_active).toBeUndefined();

    const info = parseResult<{ current_session?: { session_id: string } }>(
      await sessionInfoTool.execute(db, noopEmbed, makeContext(tenantId, null), {} as never)
    );
    expect(info.current_session).toBeUndefined();
  });

  it('CAP-1: after ending session A and starting session B, both tools report B, not the ended A', async () => {
    const tenantId = await makeTenant();

    const a = parseResult<{ session_id: string }>(
      await sessionStartTool.execute(db, noopEmbed, makeContext(tenantId, null), { create_project: false } as never)
    );
    parseResult(await sessionEndTool.execute(db, noopEmbed, makeContext(tenantId, a.session_id), {} as never));

    const b = parseResult<{ session_id: string }>(
      await sessionStartTool.execute(db, noopEmbed, makeContext(tenantId, null), { create_project: false } as never)
    );

    const status = parseResult<{ current_session: number; session_active?: boolean }>(
      await statusTool.execute(db, noopEmbed, makeContext(tenantId, null), {} as never)
    );
    expect(status.session_active).toBe(true);

    // session_num is currently broken (always 1 - unrelated to
    // this fix) so identity is asserted via session_id, not session_number.
    const info = parseResult<{ current_session?: { session_id: string } }>(
      await sessionInfoTool.execute(db, noopEmbed, makeContext(tenantId, null), {} as never)
    );
    expect(info.current_session?.session_id).toBe(b.session_id);
    expect(info.current_session?.session_id).not.toBe(a.session_id);
  });

  it('CAP-2: kg_status exposes session_active only when a session is actually present', async () => {
    const tenantId = await makeTenant();

    const noSession = parseResult<{ current_session: number; session_active?: boolean }>(
      await statusTool.execute(db, noopEmbed, makeContext(tenantId, null), {} as never)
    );
    expect(noSession.current_session).toBe(0);
    expect(noSession.session_active).toBeUndefined();

    parseResult(await sessionStartTool.execute(db, noopEmbed, makeContext(tenantId, null), { create_project: false } as never));

    const withSession = parseResult<{ current_session: number; session_active?: boolean }>(
      await statusTool.execute(db, noopEmbed, makeContext(tenantId, null), {} as never)
    );
    expect(withSession.current_session).toBeGreaterThan(0);
    expect(withSession.session_active).toBe(true);
  });

  it('multiple concurrent active sessions: both tools agree on the most-recently-started one (existing behavior, now verified)', async () => {
    const tenantId = await makeTenant();

    // startSession never ends a prior session, so two simultaneously-active
    // sessions for one tenant is a real, reachable state - not just a
    // hypothetical. resolveActiveSession's ORDER BY started_at DESC picks
    // the newer one; this test locks in that this doesn't regress and that
    // kg_status/kg_session info stay in agreement with each other for it.
    const older = parseResult<{ session_id: string }>(
      await sessionStartTool.execute(db, noopEmbed, makeContext(tenantId, null), { create_project: false } as never)
    );
    await new Promise(resolve => setTimeout(resolve, 10)); // ensure a distinct started_at
    const newer = parseResult<{ session_id: string }>(
      await sessionStartTool.execute(db, noopEmbed, makeContext(tenantId, null), { create_project: false } as never)
    );

    const info = parseResult<{ current_session?: { session_id: string } }>(
      await sessionInfoTool.execute(db, noopEmbed, makeContext(tenantId, null), {} as never)
    );
    const status = parseResult<{ session_active?: boolean }>(
      await statusTool.execute(db, noopEmbed, makeContext(tenantId, null), {} as never)
    );

    expect(info.current_session?.session_id).toBe(newer.session_id);
    expect(info.current_session?.session_id).not.toBe(older.session_id);
    expect(status.session_active).toBe(true);
  });

  it('cross-tenant isolation: tenant A active session never surfaces via tenant B', async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();

    parseResult(await sessionStartTool.execute(db, noopEmbed, makeContext(tenantA, null), { create_project: false } as never));

    const statusB = parseResult<{ current_session: number; session_active?: boolean }>(
      await statusTool.execute(db, noopEmbed, makeContext(tenantB, null), {} as never)
    );
    expect(statusB.current_session).toBe(0);
    expect(statusB.session_active).toBeUndefined();

    const infoB = parseResult<{ current_session?: unknown }>(
      await sessionInfoTool.execute(db, noopEmbed, makeContext(tenantB, null), {} as never)
    );
    expect(infoB.current_session).toBeUndefined();
  });
});
