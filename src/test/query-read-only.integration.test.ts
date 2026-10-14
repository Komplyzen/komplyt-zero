/**
 * Integration tests for the `kg_query` `read_only` flag.
 *
 * The query path has exactly one write: implicitActivateBatch on the
 * returned nodes of the non-spread branch (query.ts), which bumps
 * decay_score, last_activated and session_activated. A benchmark (or any
 * read-only consumer) must be able to observe without reinforcing, otherwise
 * retrieval depends on question order. read_only=true skips that write;
 * the default keeps the existing behaviour.
 *
 * State is created through nodeCreateTool.execute and verified through root
 * queries, against the migration-chain-provisioned database from
 * connectTestDb().
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { nodeCreateTool } from '../tools/node-create.js';
import { queryTool } from '../tools/query.js';
import { KgDbClient, KgTokenPayload, ToolContext } from '../contracts.js';
import { dbFactory } from '../db.js';
import { connectTestDb, wipeData } from './connect.js';

let rootDb: Surreal;

// Constant vectors: every node is equally similar to every query, so the
// semantic path returns all of them and the test does not depend on
// embedding quality.
const mockEmbed = {
  embedDocuments: async (texts: string[]) => texts.map(() => Array(1024).fill(0.1)),
  embedQuery: async () => Array(1024).fill(0.1),
  model: 'test-mock',
  dimensions: 1024 as const,
};

const TENANT = 'ro_tenant';
const USER = 'ro_user';
// Nodes are created in SESSION_A. The write-path test queries from SESSION_B
// so that session_activated flipping to B is unambiguous evidence of a write;
// with one session the field would be rewritten to the value it already had.
const SESSION_A = 'session:ro_session_a';
const SESSION_B = 'session:ro_session_b';

function claimsFor(tenantId: string, userId: string): KgTokenPayload {
  return {
    sub: userId,
    tenantId,
    scope: 'kg:read kg:write',
    principals: [`principal:user_${userId}`, `principal:tenant_${tenantId}`],
    projects: [],
    tier: 'free',
  };
}

function ctxFor(session: string): ToolContext {
  return {
    tenantId: TENANT,
    currentSession: session,
    projects: [],
    scope: 'kg:read kg:write',
    claims: claimsFor(TENANT, USER),
  };
}

interface ActivationRow {
  id: string;
  decay_score: number;
  last_activated: string;
  session_activated: string | null;
}

/** Snapshot of every activation-bearing field, keyed by node id, plus the decay_event count. */
async function snapshot(): Promise<{ nodes: Map<string, ActivationRow>; decayEvents: number }> {
  const [rows, counts] = await rootDb.query<[ActivationRow[], Array<{ count: number }>]>(
    `SELECT id, decay_score, last_activated, session_activated FROM node WHERE tenant = type::record('tenant', $tenant);
     SELECT count() AS count FROM decay_event WHERE session_id.tenant = type::record('tenant', $tenant) GROUP ALL;`,
    { tenant: TENANT }
  );
  const nodes = new Map<string, ActivationRow>();
  for (const r of rows) {
    nodes.set(String(r.id), {
      id: String(r.id),
      decay_score: r.decay_score,
      last_activated: String(r.last_activated),
      session_activated: r.session_activated == null ? null : String(r.session_activated),
    });
  }
  return { nodes, decayEvents: counts[0]?.count ?? 0 };
}

function expectUntouched(
  before: Awaited<ReturnType<typeof snapshot>>,
  after: Awaited<ReturnType<typeof snapshot>>
): void {
  // decay_event: implicit activation has never logged one, so this count is
  // an invariant of the query path rather than something read_only gates.
  // Pinned so that if implicit activation ever starts logging, read_only is
  // forced to gate that too.
  expect(after.decayEvents).toBe(before.decayEvents);
  expect(after.nodes.size).toBe(before.nodes.size);
  for (const [id, b] of before.nodes) {
    const a = after.nodes.get(id);
    expect(a, `node ${id} vanished`).toBeDefined();
    expect(a!.decay_score).toBe(b.decay_score);
    expect(a!.last_activated).toBe(b.last_activated);
    expect(a!.session_activated).toBe(b.session_activated);
  }
}

function parseResult<T>(result: { content: Array<{ text: string }>; isError?: boolean }): T {
  if (result.isError) {
    throw new Error(`Tool returned error: ${result.content[0]?.text}`);
  }
  return JSON.parse(result.content[0].text) as T;
}

type QueryOut = { nodes: Array<{ id: string }>; count: number; mode?: string };

describe('kg_query read_only', () => {
  let skipTests = false;
  let db: KgDbClient;
  const createdIds: string[] = [];

  // Runtime skip: a skipped test must REPORT as skipped, never pass vacuously.
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

    // Seed as root (bypasses RLS): tenant, project, two open sessions,
    // principals, and the tenant's default container granted to both
    // principals, matching what the Komplyt side provisions for a real tenant.
    await rootDb.query(`
      CREATE tenant:${TENANT} SET name = 'Read-only tenant';
      CREATE project:ro_project SET name = 'ro-project', tenant = tenant:${TENANT};
      CREATE ${SESSION_A} SET tenant = tenant:${TENANT}, project = project:ro_project, session_num = 1;
      CREATE ${SESSION_B} SET tenant = tenant:${TENANT}, project = project:ro_project, session_num = 2;
      CREATE principal:user_${USER} SET type = 'User', ref_id = '${USER}';
      CREATE principal:tenant_${TENANT} SET type = 'Tenant', ref_id = '${TENANT}';
      CREATE container:ro_container SET
        name = 'Company Knowledge',
        tenant = tenant:${TENANT},
        owner = principal:tenant_${TENANT},
        granted_principals = [principal:user_${USER}, principal:tenant_${TENANT}];
    `);

    db = await dbFactory.createScoped(claimsFor(TENANT, USER));

    // Known state through the code under test, not direct writes. The third
    // node relates to the first so include_related has something to pull in.
    for (const content of ['Fixed fee, not hourly', 'Tone: direct, no fluff']) {
      const data = parseResult<{ id: string }>(
        await nodeCreateTool.execute(db, mockEmbed, ctxFor(SESSION_A), {
          type: 'observation',
          content,
        } as never)
      );
      createdIds.push(data.id);
    }
    const related = parseResult<{ id: string; edges_created: number }>(
      await nodeCreateTool.execute(db, mockEmbed, ctxFor(SESSION_A), {
        type: 'decision',
        content: 'Client under NDA until Q3',
        relates_to: [createdIds[0]],
      } as never)
    );
    expect(related.edges_created).toBe(1);
    createdIds.push(related.id);
  });

  afterAll(async () => {
    await db?.close();
    await rootDb?.close();
  });

  it('read_only=true on the semantic path returns nodes and leaves activation state untouched', async () => {
    const before = await snapshot();
    expect(before.nodes.size).toBe(3);

    const result = parseResult<QueryOut>(
      await queryTool.execute(db, mockEmbed, ctxFor(SESSION_B), {
        text: 'pricing',
        spread: false,
        read_only: true,
        limit: 10,
        include_edges: false,
        include_neighbors: false,
      } as never)
    );

    // The flag must not turn the query into a no-op: the nodes are visible.
    expect(result.count).toBeGreaterThan(0);
    for (const n of result.nodes) expect(createdIds).toContain(n.id);

    expectUntouched(before, await snapshot());
  });

  it('read_only=true on the filter path (no text) leaves activation state untouched', async () => {
    const before = await snapshot();

    const result = parseResult<QueryOut>(
      await queryTool.execute(db, mockEmbed, ctxFor(SESSION_B), {
        type: 'observation',
        spread: false,
        read_only: true,
        limit: 10,
        include_edges: false,
        include_neighbors: false,
      } as never)
    );
    expect(result.count).toBe(2);

    expectUntouched(before, await snapshot());
  });

  it('read_only=true also spares nodes pulled in by include_related', async () => {
    // Related nodes are merged into responseNodes before nodeIds is derived,
    // so the guard covers them too. Pin that so a refactor that activates
    // seeds and related nodes separately cannot silently reintroduce a write.
    const before = await snapshot();

    const result = parseResult<QueryOut>(
      await queryTool.execute(db, mockEmbed, ctxFor(SESSION_B), {
        type: 'decision',
        spread: false,
        include_related: true,
        read_only: true,
        limit: 10,
        include_edges: false,
        include_neighbors: false,
      } as never)
    );
    // The decision seed plus the observation it relates to.
    expect(result.nodes.map((n) => n.id).sort()).toEqual([createdIds[0], createdIds[2]].sort());

    expectUntouched(before, await snapshot());
  });

  it('read_only=true is a no-op on the spreading_activation branch, which never activated implicitly', async () => {
    const before = await snapshot();

    const result = parseResult<QueryOut>(
      await queryTool.execute(db, mockEmbed, ctxFor(SESSION_B), {
        text: 'pricing',
        spread: true,
        spread_hops: 1,
        read_only: true,
        limit: 10,
        include_edges: false,
        include_neighbors: false,
      } as never)
    );
    expect(result.mode).toBe('spreading_activation');
    expect(result.nodes.length).toBeGreaterThan(0);

    expectUntouched(before, await snapshot());
  });

  it('default (read_only omitted) still implicitly activates the returned nodes', async () => {
    const before = await snapshot();

    const result = parseResult<QueryOut>(
      await queryTool.execute(db, mockEmbed, ctxFor(SESSION_B), {
        text: 'pricing',
        spread: false,
        limit: 10,
        include_edges: false,
        include_neighbors: false,
      } as never)
    );
    expect(result.count).toBeGreaterThan(0);

    const after = await snapshot();
    // Fresh nodes start at 1.0 and implicit activation clamps to the 0.85
    // ceiling, so "activated" means changed, not increased. session_activated
    // flips from the creating session A to the querying session B.
    for (const n of result.nodes) {
      const b = before.nodes.get(n.id)!;
      const a = after.nodes.get(n.id)!;
      expect(a.decay_score).not.toBe(b.decay_score);
      expect(a.last_activated).not.toBe(b.last_activated);
      expect(b.session_activated).toBe(SESSION_A);
      expect(a.session_activated).toBe(SESSION_B);
    }
  });
});
