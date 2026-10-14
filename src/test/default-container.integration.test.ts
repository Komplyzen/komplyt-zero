/**
 * Integration tests for first-use provisioning of a tenant's default container.
 *
 * Hosted and local mode share one path: the first kg_node_create without a container (or a project
 * create) makes the tenant's "Company Knowledge" container, on the caller's own scoped connection.
 * Finding behind it: on production only 1 tenant row and 1 principal row exist for 28 tenants with
 * containers, because the RLS silently drops tenant and principal CREATEs from a scoped connection
 * while allowing the container CREATE. Isolation runs on $auth.tenantId, so nothing needs those rows.
 *
 * Signs in through the real kg_server access (migrations), writes through the real tools.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import {
  EMBEDDING_DIMENSIONS,
  principalId,
  type EmbeddingProvider,
  type KgDbClient,
  type KgTokenPayload,
  type ToolContext,
} from '../contracts.js';
import { dbFactory } from '../db.js';
import { nodeCreateTool } from '../tools/node-create.js';
import { sessionStartTool } from '../tools/session-start.js';
import { connectTestDb, wipeData } from './connect.js';

let rootDb: Surreal;

const embed: EmbeddingProvider = {
  embedDocuments: async (texts) => texts.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0.01)),
  embedQuery: async () => new Array(EMBEDDING_DIMENSIONS).fill(0.01),
  model: 'test-fixture',
  dimensions: EMBEDDING_DIMENSIONS,
};

function claimsFor(tenantId: string, sub: string): KgTokenPayload {
  return {
    sub,
    tenantId,
    projects: [],
    scope: 'kg:read kg:write',
    principals: [principalId('User', sub), principalId('Tenant', tenantId)],
    tier: 'free',
    platformRole: 'member',
  };
}

function ctxFor(claims: KgTokenPayload, currentSession: string | null): ToolContext {
  return {
    claims,
    tenantId: claims.tenantId,
    projects: claims.projects,
    scope: claims.scope,
    currentSession,
  };
}

/** A scoped connection plus a started session, the way a client would arrive. */
async function arrive(tenantId: string, sub: string, project = 'p') {
  const claims = claimsFor(tenantId, sub);
  const db: KgDbClient = await dbFactory.createScoped(claims);
  const started = await sessionStartTool.execute(db, embed, ctxFor(claims, null), {
    project,
    create_project: true,
  });
  expect(started.isError, started.content[0]?.text).toBeFalsy();
  const sessionId = JSON.parse(started.content[0].text).session_id as string;
  return { claims, db, ctx: ctxFor(claims, sessionId) };
}

/**
 * Arrive and then drop the tenant's container, the state the first kg_node_create meets when a
 * project exists but no container does (the project create used to be the only place one appeared).
 */
async function arriveWithoutContainer(tenantId: string, sub: string, project = 'p') {
  const arrived = await arrive(tenantId, sub, project);
  await rootDb.query(`DELETE container WHERE tenant = type::record('tenant', $t)`, { t: tenantId });
  return arrived;
}

const containersOf = async (tenantId: string) =>
  (
    await rootDb.query<Array<Array<{ id: unknown; name: string }>>>(
      `SELECT id, name FROM container WHERE tenant = type::record('tenant', $t)`,
      { t: tenantId }
    )
  )[0];

// Each arrive() is a scoped signin plus a session start; two tenants or users in one test exceed the
// 5s default over the WAN to the CI database (#140 integration run). Real work, not a hang.
describe('first-use default container (CAP-2)', { timeout: 30_000 }, () => {
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
  });

  beforeEach(async () => {
    if (!skipTests) await wipeData(rootDb);
  });

  afterAll(async () => {
    await rootDb?.close();
  });

  it('a project with no container yet has none until the first write', async () => {
    const { db } = await arriveWithoutContainer('fresh-1', 'u1');
    expect(await containersOf('fresh-1')).toHaveLength(0);
    await db.close();
  });

  it('the first kg_node_create without a container makes exactly one default container and uses it', async () => {
    const { db, ctx } = await arriveWithoutContainer('fresh-2', 'u1');
    const res = await nodeCreateTool.execute(db, embed, ctx, { type: 'observation', content: 'first' });
    expect(res.isError, res.content[0]?.text).toBeFalsy();

    const containers = await containersOf('fresh-2');
    expect(containers).toHaveLength(1);
    expect(containers[0].name).toBe('Company Knowledge');

    const nodes = await rootDb.query<Array<Array<{ container: unknown }>>>(
      `SELECT container FROM node WHERE tenant = type::record('tenant', 'fresh-2')`
    );
    expect(nodes[0]).toHaveLength(1);
    expect(String(nodes[0][0].container)).toBe(String(containers[0].id));
    await db.close();
  });

  it('hosted decision: a tenant whose container was hard-purged gets a fresh one on its next write', async () => {
    // arriveWithoutContainer removes the row the way purgeContainer would. Recreating (not refusing)
    // is the intended behaviour of first-use provisioning for every mode; this pins it.
    const { db, ctx } = await arriveWithoutContainer('purged-1', 'u1');
    const res = await nodeCreateTool.execute(db, embed, ctx, { type: 'observation', content: 'after purge' });
    expect(res.isError, res.content[0]?.text).toBeFalsy();
    expect(await containersOf('purged-1')).toHaveLength(1);
    await db.close();
  });

  it('a soft-deleted default container is refused (NOT_FOUND), never written into or silently replaced', async () => {
    const { db, ctx } = await arrive('deleted-1', 'u1');
    await rootDb.query(`UPDATE container SET deleted_at = time::now() WHERE tenant = tenant:⟨deleted-1⟩`);
    const res = await nodeCreateTool.execute(db, embed, ctx, { type: 'observation', content: 'into the void' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/deleted/i);
    expect(await containersOf('deleted-1')).toHaveLength(1); // still the one soft-deleted row
    const nodes = await rootDb.query<Array<Array<unknown>>>(`SELECT id FROM node WHERE content = 'into the void'`);
    expect(nodes[0]).toHaveLength(0);
    await db.close();
  });

  it('a second create adds no second container', async () => {
    const { db, ctx } = await arriveWithoutContainer('fresh-3', 'u1');
    for (const content of ['one', 'two', 'three']) {
      const res = await nodeCreateTool.execute(db, embed, ctx, { type: 'observation', content });
      expect(res.isError, res.content[0]?.text).toBeFalsy();
    }
    expect(await containersOf('fresh-3')).toHaveLength(1);
    await db.close();
  });

  it('two first writes at once still leave exactly one container, and both succeed', async () => {
    const a = await arriveWithoutContainer('fresh-4', 'u1', 'pa');
    const b = await arrive('fresh-4', 'u2', 'pb');
    await rootDb.query(`DELETE container WHERE tenant = type::record('tenant', 'fresh-4')`);
    const [ra, rb] = await Promise.all([
      nodeCreateTool.execute(a.db, embed, a.ctx, { type: 'observation', content: 'from a' }),
      nodeCreateTool.execute(b.db, embed, b.ctx, { type: 'observation', content: 'from b' }),
    ]);
    expect(ra.isError, ra.content[0]?.text).toBeFalsy();
    expect(rb.isError, rb.content[0]?.text).toBeFalsy();
    expect(await containersOf('fresh-4')).toHaveLength(1);
    await a.db.close();
    await b.db.close();
  });

  it('a project create also provisions it, once, without a tenant or principal row', async () => {
    const { db } = await arrive('fresh-5', 'u1');
    expect(await containersOf('fresh-5')).toHaveLength(1);
    const again = await sessionStartTool.execute(db, embed, ctxFor(claimsFor('fresh-5', 'u1'), null), {
      project: 'second',
      create_project: true,
    });
    expect(again.isError, again.content[0]?.text).toBeFalsy();
    expect(await containersOf('fresh-5')).toHaveLength(1);
    await db.close();
  });

  it('another user of the same tenant writes into the same container', async () => {
    const a = await arrive('fresh-6', 'u1', 'pa');
    await nodeCreateTool.execute(a.db, embed, a.ctx, { type: 'observation', content: 'by u1' });
    const b = await arrive('fresh-6', 'u2', 'pb');
    const res = await nodeCreateTool.execute(b.db, embed, b.ctx, { type: 'observation', content: 'by u2' });
    expect(res.isError, res.content[0]?.text).toBeFalsy();
    expect(await containersOf('fresh-6')).toHaveLength(1);
    await a.db.close();
    await b.db.close();
  });

  it('tenants stay apart: each gets its own container and cannot see the other\'s', async () => {
    const a = await arriveWithoutContainer('fresh-7a', 'u7a');
    const b = await arriveWithoutContainer('fresh-7b', 'u7b');
    await nodeCreateTool.execute(a.db, embed, a.ctx, { type: 'observation', content: 'a' });
    await nodeCreateTool.execute(b.db, embed, b.ctx, { type: 'observation', content: 'b' });
    expect(await containersOf('fresh-7a')).toHaveLength(1);
    expect(await containersOf('fresh-7b')).toHaveLength(1);
    const seenByA = await a.db.query<{ id: string }>('SELECT id FROM container');
    expect(seenByA).toHaveLength(1);
    await a.db.close();
    await b.db.close();
  });

  it('an explicit container that does not exist is still NOT_FOUND and provisions nothing', async () => {
    // No container exists, so an unknown explicit id must not trigger provisioning.
    const { db, ctx } = await arriveWithoutContainer('fresh-8', 'u1');
    const res = await nodeCreateTool.execute(db, embed, ctx, {
      type: 'observation',
      content: 'x',
      container: 'container:does_not_exist',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/i);
    expect(await containersOf('fresh-8')).toHaveLength(0);
    await db.close();
  });
});
