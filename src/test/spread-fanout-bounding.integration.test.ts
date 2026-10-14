/**
 * Integration tests for spread fan-out bounding.
 *
 * PR #83 batched spreading-activation's per-hop neighbor query into one
 * round trip but left both its input (active-node-id set) and output (edge
 * count) unbounded - a graph with enough fan-out could still make one hop's
 * query carry hundreds of node ids and pull back a correspondingly huge
 * edge set. This tests the two bounds added to close that gap:
 *  - CAP-1: the active-node set is capped to the top-N by score before each
 *    hop's query (from hop 1 onward only - hop 0 is seeds, already bounded
 *    by params.limit, not fan-out, so capping it would change
 *    spread_hops=1 results).
 *  - CAP-2: the batched neighbor query itself is LIMIT-bounded, so even a
 *    single hub node's edges can't produce an unbounded result.
 *
 * Runs against the externally-provisioned test database (real migration chain).
 *
 * Run with: bun run vitest run spread-fanout-bounding.integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { EMBEDDING_DIMENSIONS, EmbeddingProvider, KgDbClient, ToolContext } from '../contracts.js';
import { queryTool, getNeighborsWithWeightsBatch } from '../tools/query.js';
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

describe('Spread Fan-Out Bounding', () => {
  let skipTests = false;

  // Runtime skip: a skipped test must REPORT as skipped. The old
  // `if (skipTests) return` pattern counted empty test bodies as PASSED
  // (weeks of green CI over zero assertions).
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

  async function makeTenantAndSession(): Promise<{ tenantId: string; sessionId: string }> {
    const [tenant] = await db.query<{ id: string }>('CREATE tenant SET name = $name', { name: `t-${Date.now()}-${Math.random()}` });
    const [session] = await db.query<{ id: string }>('CREATE session SET tenant = $tenant', { tenant: tenant.id });
    return { tenantId: String(tenant.id).replace('tenant:', ''), sessionId: String(session.id) };
  }

  async function makeNode(tenantId: string, sessionId: string, content: string, type = 'observation'): Promise<string> {
    const [node] = await db.query<{ id: string }>(
      `CREATE node SET
        content = $content,
        type = $type,
        source = 'test',
        tenant = type::record('tenant', $tenant_id),
        session_created = type::record('session', $session_id),
        session_activated = type::record('session', $session_id)`,
      { content, type, tenant_id: tenantId.replace('tenant:', ''), session_id: sessionId.replace('session:', '') }
    );
    return String(node.id);
  }

  function makeContext(tenantId: string, sessionId: string): ToolContext {
    return {
      claims: { sub: 'user:test', tenantId, projects: [], scope: 'kg:read kg:write', principals: [], tier: 'free' },
      tenantId,
      projects: [],
      scope: 'kg:read kg:write',
      currentSession: sessionId,
    };
  }

  async function makeEdge(sessionId: string, from: string, to: string, weight: number): Promise<void> {
    await db.query(
      `LET $from = type::record('node', $a);
       LET $to = type::record('node', $b);
       RELATE $from->edge->$to SET type = 'explicit', weight = $weight, session_reinforced = type::record('session', $session_id)`,
      { a: from.replace('node:', ''), b: to.replace('node:', ''), weight, session_id: sessionId.replace('session:', '') }
    );
  }

  /**
   * Builds one seed with 65 hop-1 neighbors (fan-out 65 > the 50-node cap):
   * - 55 "keep" neighbors at weight 0.9 (rank ahead of the canary on score)
   * - one "champion" neighbor at weight 0.99 (highest-ranked), with its own
   *   hop-2 child - proves hop-2 traversal works for surviving branches
   * - one "canary" neighbor at weight 0.21 (activation score 1.0*0.21*0.5 =
   *   0.105, just above the default 0.1 activation_threshold so it isn't
   *   dropped by that pre-existing filter, but still ranked below the 0.9+
   *   weight "keep" neighbors - lowest-ranked, guaranteed dropped by the
   *   top-50 cap at the hop 0->1 boundary), with its own hop-2 child - its
   *   absence at spread_hops=2 (but presence itself at spread_hops=1)
   *   proves the cap applies from hop 1 onward, not at hop 0
   * - 8 more filler neighbors at weight 0.9 to reach 65 total fan-out
   */
  async function makeHighFanoutGraph(): Promise<{
    tenantId: string;
    sessionId: string;
    seed: string;
    champion: string;
    championChild: string;
    canary: string;
    canaryChild: string;
  }> {
    const { tenantId, sessionId } = await makeTenantAndSession();
    const seed = await makeNode(tenantId, sessionId, 'seed', 'observation');

    const champion = await makeNode(tenantId, sessionId, 'champion neighbor', 'decision');
    await makeEdge(sessionId, seed, champion, 0.99);
    const championChild = await makeNode(tenantId, sessionId, 'champion child (hop 2)', 'decision');
    await makeEdge(sessionId, champion, championChild, 0.99);

    const canary = await makeNode(tenantId, sessionId, 'canary neighbor', 'decision');
    await makeEdge(sessionId, seed, canary, 0.21);
    const canaryChild = await makeNode(tenantId, sessionId, 'canary child (hop 2)', 'decision');
    await makeEdge(sessionId, canary, canaryChild, 0.99);

    // 63 more "keep" neighbors (55 required to exceed the 50-cap alongside
    // champion/canary/seed, padded to 63 for a comfortably wide margin)
    for (let i = 0; i < 63; i++) {
      const filler = await makeNode(tenantId, sessionId, `filler neighbor ${i}`, 'decision');
      await makeEdge(sessionId, seed, filler, 0.9);
    }

    return { tenantId, sessionId, seed, champion, championChild, canary, canaryChild };
  }

  it('CAP-1: caps the active-node set from hop 1 onward - a low-ranked branch is pruned before its hop-2 neighbors are queried', async () => {
    const { tenantId, sessionId, championChild, canaryChild } = await makeHighFanoutGraph();

    const result = parseResult<{ nodes: Array<{ id: string }> }>(
      await queryTool.execute(db, noopEmbed, makeContext(tenantId, sessionId), {
        type: 'observation',
        spread: true,
        spread_hops: 2,
        limit: 100,
        neighbors_limit: 1,
        include_related: false,
        include_edges: false,
        include_neighbors: false,
      } as never)
    );
    const ids = result.nodes.map(n => n.id);

    expect(ids).toContain(championChild);
    expect(ids).not.toContain(canaryChild);
  }, 180000); // WAN headroom: CI runs against the remote staging instance; the ~1200 sequential seed round-trips dominate, not the bounded query under test

  it('CAP-1: does not cap hop 0 - all 65 hop-1 neighbors (including the weak canary) are activated when spread_hops=1', async () => {
    const { tenantId, sessionId, canary } = await makeHighFanoutGraph();

    const result = parseResult<{ nodes: Array<{ id: string }> }>(
      await queryTool.execute(db, noopEmbed, makeContext(tenantId, sessionId), {
        type: 'observation',
        spread: true,
        spread_hops: 1,
        limit: 100,
        neighbors_limit: 1,
        include_related: false,
        include_edges: false,
        include_neighbors: false,
      } as never)
    );
    const ids = result.nodes.map(n => n.id);

    // 1 seed (type=observation, matches the filter) + up to 100 spread
    // results (limit=100) - the canary must be among them since hop 0 is
    // never capped (only accumulated activation from hop 1 onward is).
    expect(ids).toContain(canary);
  }, 180000); // WAN headroom: CI targets the remote staging instance; sequential seeding round-trips dominate, not the bounded query under test

  it('CAP-2: a single hub node with 600+ edges does not blow up the batched neighbor query', async () => {
    const { tenantId, sessionId } = await makeTenantAndSession();
    const hub = await makeNode(tenantId, sessionId, 'hub', 'observation');

    for (let i = 0; i < 600; i++) {
      const leaf = await makeNode(tenantId, sessionId, `hub leaf ${i}`, 'decision');
      await makeEdge(sessionId, hub, leaf, 0.5);
    }

    // The tool's own response `limit` maxes at 100 (below the 500-edge
    // bound), so the internal bound can't be observed through kg_query's
    // output - assert it directly against the exported function instead.
    const bySource = await getNeighborsWithWeightsBatch(db, [hub]);
    const hubEdges = bySource.get(hub) ?? [];
    expect(hubEdges.length).toBeGreaterThan(0);
    expect(hubEdges.length).toBeLessThanOrEqual(250); // MAX_EDGES_PER_BATCH_QUERY (500) split across in/out directions

    const start = Date.now();
    const result = parseResult<{ nodes: Array<{ id: string }> }>(
      await queryTool.execute(db, noopEmbed, makeContext(tenantId, sessionId), {
        type: 'observation',
        spread: true,
        spread_hops: 1,
        limit: 100,
        neighbors_limit: 1,
        include_related: false,
        include_edges: false,
        include_neighbors: false,
      } as never)
    );
    const elapsed = Date.now() - start;

    // Must also complete end-to-end (no error/crash) in bounded time - a
    // truly unbounded query against 600 edges would be the exact
    // 502-causing shape this spec exists to prevent.
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(15000);
  }, 180000); // WAN headroom: CI targets the remote staging instance; sequential seeding round-trips dominate, not the bounded query under test

  it('cumulative cost across a 3-hop spread over a wide graph stays bounded (SPEC CAP-1 cumulative requirement)', async () => {
    const { tenantId, sessionId } = await makeTenantAndSession();
    const seed = await makeNode(tenantId, sessionId, 'seed', 'observation');

    // 3 levels deep, ~60-wide fan-out at each level - without cumulative
    // bounding, hop 3's active-node candidate pool would be seed + up to 60
    // hop-1 nodes + up to 60*60 hop-2 nodes (3600), each hop re-querying the
    // full accumulated set. With the cap, each hop's query stays bounded
    // regardless of how wide the graph actually is.
    let previousLevel = [seed];
    for (let level = 0; level < 3; level++) {
      const nextLevel: string[] = [];
      for (const parent of previousLevel.slice(0, 3)) {
        // Fan out from a handful of parents per level (not every parent -
        // keeps fixture construction time reasonable while still producing
        // a candidate pool that would be unbounded without capping).
        for (let i = 0; i < 60; i++) {
          const child = await makeNode(tenantId, sessionId, `L${level} child ${i}`, 'decision');
          await makeEdge(sessionId, parent, child, 0.9);
          nextLevel.push(child);
        }
      }
      previousLevel = nextLevel;
    }

    const start = Date.now();
    const result = parseResult<{ nodes: Array<{ id: string }> }>(
      await queryTool.execute(db, noopEmbed, makeContext(tenantId, sessionId), {
        type: 'observation',
        spread: true,
        spread_hops: 3,
        limit: 100,
        neighbors_limit: 1,
        include_related: false,
        include_edges: false,
        include_neighbors: false,
      } as never)
    );
    const elapsed = Date.now() - start;

    expect(result.nodes.length).toBeGreaterThan(0);
    // Bounded well under the per-call QUERY_TIMEOUT_MS (5s) plus headroom -
    // an unbounded cumulative query against a 3-level, 60-wide graph
    // (potentially thousands of candidate nodes by hop 3) would be the
    // exact shape that caused the original 502s.
    expect(elapsed).toBeLessThan(15000);
  }, 180000); // WAN headroom: ~1080 sequential seed round-trips against the remote staging instance; the elapsed<15000 guard on the query itself stays strict

  it('zero-activation hop (no neighbor clears the threshold) does not error - existing empty-input early return is preserved', async () => {
    const { tenantId, sessionId } = await makeTenantAndSession();
    const seed = await makeNode(tenantId, sessionId, 'isolated seed', 'observation');
    // Edge weight low enough that seed_score(1.0) * weight * spread_factor(0.5)
    // never clears the default activation_threshold (0.1).
    const unreachable = await makeNode(tenantId, sessionId, 'unreachable neighbor', 'decision');
    await makeEdge(sessionId, seed, unreachable, 0.05);

    const result = parseResult<{ nodes: Array<{ id: string; activation_source?: string }> }>(
      await queryTool.execute(db, noopEmbed, makeContext(tenantId, sessionId), {
        type: 'observation',
        spread: true,
        spread_hops: 3,
        limit: 100,
        include_related: false,
        include_edges: false,
        include_neighbors: false,
      } as never)
    );

    const ids = result.nodes.map(n => n.id);
    expect(ids).toContain(seed);
    expect(ids).not.toContain(unreachable);
  }, 180000); // WAN headroom: CI targets the remote staging instance; sequential seeding round-trips dominate, not the bounded query under test
});
