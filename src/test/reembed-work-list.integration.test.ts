/**
 * bin/reembed.ts selection: which nodes the work list (buildWorkList) picks for
 * the configured model. Known state comes from kg_node_create itself, so the
 * test covers what the tool records (embedding, embedding_model), not
 * hand-written rows.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { nodeCreateTool } from '../tools/node-create.js';
import { sessionStartTool } from '../tools/session-start.js';
import {
  KgDbClient,
  ToolContext,
  KgTokenPayload,
  EmbeddingProvider,
  EMBEDDING_DIMENSIONS,
} from '../contracts.js';
import { createFixtureProvider } from '../embed.js';
import { buildWorkList } from '../bin/reembed-work-list.js';
import { connectTestDb, wipeData } from './connect.js';

function createDbClient(db: Surreal): KgDbClient {
  return {
    async query<T>(sql: string, vars?: Record<string, unknown>): Promise<T[]> {
      const results = await db.query<T[][]>(sql, vars);
      return results.flat();
    },
    async queryOne<T>(sql: string, vars?: Record<string, unknown>): Promise<T | null> {
      const results = await this.query<T>(sql, vars);
      return results[0] ?? null;
    },
    async close(): Promise<void> {
      await db.close();
    },
  };
}

/** Fixture vectors, labelled as another model (what a provider switch leaves behind). */
function providerLabelled(model: string): EmbeddingProvider {
  return { ...createFixtureProvider(), model };
}

/** A provider whose embedding service is down. */
function failingProvider(): EmbeddingProvider {
  return {
    ...createFixtureProvider(),
    async embedDocuments(): Promise<number[][]> {
      throw new Error('embedding service down');
    },
  };
}

describe('reembed work list', () => {
  let db: Surreal;
  let client: KgDbClient;
  let skipTests = false;
  let sessionId: string;
  const tenantId = `reembed_tenant_${Date.now()}`;

  // A skipped test must REPORT as skipped, not pass with an empty body.
  beforeEach((ctx) => {
    if (skipTests) ctx.skip();
  });

  function createContext(session: string | null): ToolContext {
    const claims: KgTokenPayload = {
      sub: 'reembed-test-user',
      tenantId,
      projects: [],
      scope: 'kg:read kg:write',
      principals: [`principal:tenant_${tenantId}`],
      tier: 'free',
    };
    return { claims, tenantId, projects: [], scope: 'kg:read kg:write', currentSession: session };
  }

  beforeAll(async () => {
    const conn = await connectTestDb();
    if (!conn) {
      skipTests = true;
      return;
    }
    db = conn;
    await wipeData(db);
    client = createDbClient(db);

    const principalId = `tenant_${tenantId}`;
    await db.query(`CREATE type::record('tenant', $tenant_id) SET name = $tenant_id`, { tenant_id: tenantId });
    await db.query(
      `CREATE type::record('principal', $principal_id) SET type = 'Tenant', ref_id = $tenant_id`,
      { principal_id: principalId, tenant_id: tenantId }
    );
    await db.query(
      `CREATE type::record('container', $container_id) SET
        name = 'Company Knowledge',
        tenant = type::record('tenant', $tenant_id),
        owner = type::record('principal', $principal_id),
        granted_principals = [type::record('principal', $principal_id)]`,
      { container_id: `${tenantId}_default`, tenant_id: tenantId, principal_id: principalId }
    );

    const started = await sessionStartTool.execute(client, createFixtureProvider(), createContext(null), {
      project: 'reembed-test',
      create_project: true,
    });
    sessionId = JSON.parse(started.content[0].text).session_id;
  });

  afterAll(async () => {
    await db?.close();
  });

  async function create(embedWith: EmbeddingProvider, content: string): Promise<string> {
    const result = await nodeCreateTool.execute(client, embedWith, createContext(sessionId), {
      type: 'observation',
      content,
    });
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0].text).id;
  }


  async function countNodes(): Promise<number> {
    const [rows] = await db.query<[{ n: number }[]]>('SELECT count() AS n FROM node GROUP ALL');
    return rows[0]?.n ?? 0;
  }

  it('kg_node_create fails without saving when the embedding fails (no invisible nodes)', async () => {
    const before = await countNodes();
    const result = await nodeCreateTool.execute(client, failingProvider(), createContext(sessionId), {
      type: 'observation',
      content: 'Created while the embedding service was down',
    });

    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe('INTERNAL');
    expect(await countNodes()).toBe(before);
  });

  it('selects other-model and unembedded nodes, not current-model ones', async () => {
    const fixtureNode = await create(createFixtureProvider(), 'Work list: embedded by fixture');
    const cohereNode = await create(providerLabelled('cohere-embed-multilingual-v3.0'), 'Work list: embedded by cohere');
    // A node that lost its vector (e.g. written before embeddings existed): clear it as root.
    const unembeddedNode = await create(createFixtureProvider(), 'Work list: never embedded');
    await db.query("UPDATE type::record('node', $id) SET embedding = NONE, embedding_model = NONE", {
      id: unembeddedNode.replace(/^node:/, ''),
    });

    const selected = (await buildWorkList(db, 'fixture', EMBEDDING_DIMENSIONS)).map((n) => String(n.id));

    expect(selected).toContain(cohereNode);
    expect(selected).toContain(unembeddedNode);
    expect(selected).not.toContain(fixtureNode);
  });

  it('limit caps the selection; undefined means every candidate', async () => {
    const all = await buildWorkList(db, 'fixture', EMBEDDING_DIMENSIONS);
    expect(all.length).toBeGreaterThanOrEqual(2);

    expect(await buildWorkList(db, 'fixture', EMBEDDING_DIMENSIONS, 1)).toHaveLength(1);
  });

  it('rejects a limit that is not a positive integer instead of treating it as "no limit"', async () => {
    for (const bad of [0, -1, Number.NaN, 1.5]) {
      await expect(buildWorkList(db, 'fixture', EMBEDDING_DIMENSIONS, bad)).rejects.toThrow(/positive integer/);
    }
  });
});
