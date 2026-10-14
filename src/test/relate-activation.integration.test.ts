/**
 * Integration tests for the kg-traversal-batching regressions found during
 * adversarial review:
 *  - self-relate (from === to) must still double-boost, not single-boost
 *  - a dangling edge (target node deleted) must not produce a bogus neighbor id
 *  - spreading activation must attribute both directions when two active
 *    nodes are connected to each other
 *
 * Runs against the externally-provisioned test database (real migration
 * chain), so query behavior is tested against the deployed table definitions
 * (e.g. edge TYPE RELATION). Root connection bypasses table PERMISSIONS
 * entirely, so the RLS clauses in that schema don't interfere.
 *
 * Run with: bun run vitest run relate-activation.integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { ACTIVATION, EMBEDDING_DIMENSIONS, EmbeddingProvider, KgDbClient, ToolContext } from '../contracts.js';
import { applyActivationBoost } from '../activation.js';
import { relateTool } from '../tools/relate.js';
import { queryTool } from '../tools/query.js';
import { connectTestDb, wipeData } from './connect.js';

let rootDb: Surreal;
let db: KgDbClient;

const noopEmbed: EmbeddingProvider = {
  embedDocuments: async (texts: string[]) => texts.map(() => []),
  embedQuery: async () => [],
  model: 'test-mock',
  dimensions: EMBEDDING_DIMENSIONS,
};

describe('Traversal Batching Regressions', () => {
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
    // ctx.tenantId must be the bare id (matches JWT claims.tenantId contract) -
    // relate.ts/query.ts pass it straight into type::record('tenant', $tenant_id)
    // without going through extractRecordId first.
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

  function parseResult<T>(result: { content: Array<{ text: string }>; isError?: boolean }): T {
    if (result.isError) {
      throw new Error(`Tool returned error: ${result.content[0]?.text}`);
    }
    return JSON.parse(result.content[0].text) as T;
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

  it('self-relate on a non-ceiling node double-boosts (regression: was silently single-boosting under Promise.all)', async () => {
    const { tenantId, sessionId } = await makeTenantAndSession();
    const nodeId = await makeNode(tenantId, sessionId, 'decayed self-relate node');

    // Push decay_score below ceiling so a single vs double boost is distinguishable.
    await db.query("UPDATE type::record('node', $id) SET decay_score = 0.3", { id: nodeId.replace('node:', '') });

    // A self-loop edge already exists by the time getNeighborhoodStats runs
    // (relate.ts creates the edge before activating), so the real query sees
    // nodes=1, edges=1 - not edges=0. calculateLocalComplexity short-circuits
    // to 0 for nodes<2 regardless, so the expected value is the same either
    // way, but compute it against the actual (nodes=1, edges=1) inputs rather
    // than assuming edges=0 to avoid a coincidental pass.
    //
    // Under edge TYPE RELATION (migration 023) each activateNode call also
    // reactively spreads to 1-hop neighbors via graph traversal - and for a
    // self-loop the node is its own outbound AND inbound neighbor, so between
    // the two direct boosts the first call applies the reactive spread factor
    // twice to the node itself. (Under the old TYPE NORMAL edge table those
    // traversal UPDATEs were silent no-ops, which is what the previous
    // expectation encoded.) Model the full chain:
    //   boost -> spread(out) -> spread(in) -> boost   (returned value)
    // The second call's own reactive spread runs after its return value is
    // computed, so it doesn't affect to_decay_score.
    const REACTIVE_SPREAD_FACTOR = 0.1; // activation.ts (module-private)
    const spreadOnce = (s: number) => s + (ACTIVATION.CEILING - s) * REACTIVE_SPREAD_FACTOR;
    const firstBoost = applyActivationBoost(0.3, 1, 1);
    const afterSelfSpread = spreadOnce(spreadOnce(firstBoost));
    const doubleBoost = applyActivationBoost(afterSelfSpread, 1, 1);

    const result = await relateTool.execute(db, noopEmbed, makeContext(tenantId, sessionId), {
      from: nodeId,
      to: nodeId,
    });

    const output = parseResult<{ to_decay_score: number }>(result);

    // Must reflect the second boost building on the first call's writes
    // (double), not a second boost lost/recomputed off a stale base.
    expect(output.to_decay_score).toBeCloseTo(doubleBoost, 6);
    expect(output.to_decay_score).not.toBeCloseTo(firstBoost, 6);
    expect(output.to_decay_score).not.toBeCloseTo(afterSelfSpread, 6);
  });

  it('spreading activation reaches a non-seed node via a mutual edge (regression: batched hop lookup must attribute both directions)', async () => {
    const { tenantId, sessionId } = await makeTenantAndSession();
    // nodeB has a different type so it is NOT matched by the seed filter below -
    // the only way it can appear in results is via spreading over the edge.
    const nodeA = await makeNode(tenantId, sessionId, 'node A', 'observation');
    const nodeB = await makeNode(tenantId, sessionId, 'node B', 'decision');

    await db.query(
      `LET $from = type::record('node', $a);
       LET $to = type::record('node', $b);
       RELATE $from->edge->$to SET
        type = 'explicit', weight = 1.0,
        session_reinforced = type::record('session', $session_id)`,
      { a: nodeA.replace('node:', ''), b: nodeB.replace('node:', ''), session_id: sessionId.replace('session:', '') }
    );

    const result = await queryTool.execute(db, noopEmbed, makeContext(tenantId, sessionId), {
      type: 'observation',
      spread: true,
      spread_hops: 1,
      limit: 10,
    } as never);

    const output = parseResult<{ nodes: Array<{ id: string; activation_source: string }> }>(result);
    const nodeMap = new Map(output.nodes.map(n => [n.id, n]));
    expect(nodeMap.get(nodeA)?.activation_source).toBe('direct');
    expect(nodeMap.get(nodeB)?.activation_source).toBe('spread');
  });

  it('spreading activation attributes neighbors correctly when two seeds are batched in the same hop (regression: cross-source attribution bug in getNeighborsWithWeightsBatch)', async () => {
    const { tenantId, sessionId } = await makeTenantAndSession();
    const seedA = await makeNode(tenantId, sessionId, 'seed A', 'observation');
    const seedB = await makeNode(tenantId, sessionId, 'seed B', 'observation');
    const neighborOfA = await makeNode(tenantId, sessionId, 'neighbor of A only', 'decision');
    const neighborOfB = await makeNode(tenantId, sessionId, 'neighbor of B only', 'decision');

    await db.query(
      `LET $from_a = type::record('node', $a);
       LET $to_na = type::record('node', $na);
       RELATE $from_a->edge->$to_na SET type = 'explicit', weight = 1.0, session_reinforced = type::record('session', $session_id);
       LET $from_b = type::record('node', $b);
       LET $to_nb = type::record('node', $nb);
       RELATE $from_b->edge->$to_nb SET type = 'explicit', weight = 1.0, session_reinforced = type::record('session', $session_id);`,
      {
        a: seedA.replace('node:', ''), na: neighborOfA.replace('node:', ''),
        b: seedB.replace('node:', ''), nb: neighborOfB.replace('node:', ''),
        session_id: sessionId.replace('session:', ''),
      }
    );

    const result = await queryTool.execute(db, noopEmbed, makeContext(tenantId, sessionId), {
      type: 'observation',
      spread: true,
      spread_hops: 1,
      limit: 10,
    } as never);

    const output = parseResult<{ nodes: Array<{ id: string; activation_path?: string[] }> }>(result);
    const nodeMap = new Map(output.nodes.map(n => [n.id, n]));

    // If the batched query mixed up which source each row belongs to, one of
    // these would be missing or would show the wrong seed in its path.
    expect(nodeMap.get(neighborOfA)?.activation_path).toEqual([seedA, neighborOfA]);
    expect(nodeMap.get(neighborOfB)?.activation_path).toEqual([seedB, neighborOfB]);
  });

  it('spreading activation reaches a node only at the correct hop depth (regression: hop loop must re-derive the active-node set from current state each iteration)', async () => {
    const { tenantId, sessionId } = await makeTenantAndSession();
    const nodeA = await makeNode(tenantId, sessionId, 'chain A', 'observation');
    const nodeB = await makeNode(tenantId, sessionId, 'chain B', 'decision');
    const nodeC = await makeNode(tenantId, sessionId, 'chain C', 'decision');

    await db.query(
      `LET $from_a = type::record('node', $a);
       LET $to_b = type::record('node', $b);
       RELATE $from_a->edge->$to_b SET type = 'explicit', weight = 1.0, session_reinforced = type::record('session', $session_id);
       LET $from_b = type::record('node', $b);
       LET $to_c = type::record('node', $c);
       RELATE $from_b->edge->$to_c SET type = 'explicit', weight = 1.0, session_reinforced = type::record('session', $session_id);`,
      {
        a: nodeA.replace('node:', ''), b: nodeB.replace('node:', ''), c: nodeC.replace('node:', ''),
        session_id: sessionId.replace('session:', ''),
      }
    );

    const oneHop = parseResult<{ nodes: Array<{ id: string }> }>(
      await queryTool.execute(db, noopEmbed, makeContext(tenantId, sessionId), {
        type: 'observation', spread: true, spread_hops: 1, limit: 10,
      } as never)
    );
    const oneHopIds = oneHop.nodes.map(n => n.id);
    expect(oneHopIds).toContain(nodeB);
    expect(oneHopIds).not.toContain(nodeC);

    const twoHop = parseResult<{ nodes: Array<{ id: string; activation_path?: string[] }> }>(
      await queryTool.execute(db, noopEmbed, makeContext(tenantId, sessionId), {
        type: 'observation', spread: true, spread_hops: 2, limit: 10,
      } as never)
    );
    const nodeMap = new Map(twoHop.nodes.map(n => [n.id, n]));
    expect(nodeMap.get(nodeC)?.activation_path).toEqual([nodeA, nodeB, nodeC]);
  });

  it('relate.ts reports NOT_FOUND without partially activating either node when one of two distinct nodes does not exist (regression: fromExists/toExists concurrency must not change error outcomes)', async () => {
    const { tenantId, sessionId } = await makeTenantAndSession();
    const realNode = await makeNode(tenantId, sessionId, 'real node');
    const fakeNode = 'node:doesnotexist000000';

    await db.query("UPDATE type::record('node', $id) SET decay_score = 0.3", { id: realNode.replace('node:', '') });

    const result = await relateTool.execute(db, noopEmbed, makeContext(tenantId, sessionId), {
      from: realNode,
      to: fakeNode,
    });

    expect(result.isError).toBe(true);

    const after = await db.queryOne<{ decay_score: number }>(
      "SELECT decay_score FROM type::record('node', $id)",
      { id: realNode.replace('node:', '') }
    );
    // fromExists/toExists now run concurrently, but the real node must not
    // have been activated as a side effect of a call that overall failed.
    expect(after?.decay_score).toBe(0.3);
  });

  it('a dangling edge (target node deleted) is excluded from results and does not crash spreading activation', async () => {
    const { tenantId, sessionId } = await makeTenantAndSession();
    const nodeA = await makeNode(tenantId, sessionId, 'node with dangling edge', 'observation');
    const nodeB = await makeNode(tenantId, sessionId, 'node to be deleted', 'decision');

    await db.query(
      `LET $from = type::record('node', $a);
       LET $to = type::record('node', $b);
       RELATE $from->edge->$to SET
        type = 'explicit', weight = 1.0,
        session_reinforced = type::record('session', $session_id)`,
      { a: nodeA.replace('node:', ''), b: nodeB.replace('node:', ''), session_id: sessionId.replace('session:', '') }
    );

    await db.query("DELETE type::record('node', $id)", { id: nodeB.replace('node:', '') });

    const result = await queryTool.execute(db, noopEmbed, makeContext(tenantId, sessionId), {
      type: 'observation',
      spread: true,
      spread_hops: 1,
      limit: 10,
    } as never);

    const output = parseResult<{ nodes: Array<{ id: string }> }>(result);
    const ids = output.nodes.map(n => n.id);
    expect(ids).toContain(nodeA);
    // nodeB no longer exists - fetchNodesByIds naturally excludes it, but the
    // call must not throw despite the edge still referencing a deleted node.
    expect(ids).not.toContain(nodeB);
  });
});
