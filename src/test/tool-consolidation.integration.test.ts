import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { nodeCreateTool } from '../tools/node-create.js';
import { nodeUpdateTool } from '../tools/node-update.js';
import { sessionStartTool } from '../tools/session-start.js';
import { statusTool } from '../tools/status.js';
import { getLegacyTool } from '../tools/legacy.js';
import {
  KgDbClient,
  ToolContext,
  KgTokenPayload,
  EmbeddingProvider,
  EMBEDDING_DIMENSIONS,
  nodeCreateParamsSchema,
  nodeUpdateParamsSchema,
} from '../contracts.js';
import { createFixtureProvider } from '../embed.js';
import { connectTestDb, wipeData } from './connect.js';

function createMockEmbed(): EmbeddingProvider {
  return {
    model: 'test-mock',
    dimensions: EMBEDDING_DIMENSIONS,
    async embedDocuments(texts: string[]): Promise<number[][]> {
      return texts.map(() => Array(EMBEDDING_DIMENSIONS).fill(0.1));
    },
    async embedQuery(): Promise<number[]> {
      return Array(EMBEDDING_DIMENSIONS).fill(0.1);
    },
  };
}

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

describe('Tool Consolidation Integration', () => {
  let db: Surreal;
  let client: KgDbClient;
  let embed: EmbeddingProvider;
  let skipTests = false;

  // A skipped test must REPORT as skipped, not pass with an empty body.
  beforeEach((ctx) => {
    if (skipTests) ctx.skip();
  });
  const tenantId = `test_tenant_${Date.now()}`;

  beforeAll(async () => {
    const conn = await connectTestDb();
    if (!conn) {
      skipTests = true;
      return;
    }
    db = conn;
    await wipeData(db);
    client = createDbClient(db);
    embed = createMockEmbed();

    // Create tenant, principal, and default container
    const principalId = `tenant_${tenantId}`;
    await db.query(`CREATE type::record('tenant', $tenant_id) SET name = $tenant_id`, { tenant_id: tenantId });
    await db.query(`CREATE type::record('principal', $principal_id) SET type = 'Tenant', ref_id = $tenant_id`, { principal_id: principalId, tenant_id: tenantId });
    const containerId = `${tenantId}_default`;
    await db.query(`CREATE type::record('container', $container_id) SET
      name = 'Company Knowledge',
      tenant = type::record('tenant', $tenant_id),
      owner = type::record('principal', $principal_id),
      granted_principals = [type::record('principal', $principal_id)]`,
      { container_id: containerId, tenant_id: tenantId, principal_id: principalId }
    );
  });

  afterAll(async () => {
    await db?.close();
  });

  function createContext(sessionId: string | null): ToolContext {
    const claims: KgTokenPayload = {
      sub: 'test-user',
      tenantId,
      projects: [],
      scope: 'kg:read kg:write',
      principals: [`principal:tenant_${tenantId}`],
      tier: 'free',
    };
    return {
      claims,
      tenantId,
      projects: [],
      scope: 'kg:read kg:write',
      currentSession: sessionId,
    };
  }

  describe('kg_session_start and kg_status', () => {
    it('kg_session_start starts a session', async () => {
      const ctx = createContext(null);
      const result = await sessionStartTool.execute(client, embed, ctx, {
        project: 'test-project',
        create_project: true,
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBe('started');
      expect(data.session_number).toBeGreaterThan(0);
    });

    it('kg_status reports the active session', async () => {
      const startResult = await sessionStartTool.execute(client, embed, createContext(null), {
        project: 'test-project-2',
        create_project: true,
      });
      expect(startResult.isError).toBeFalsy();
      const startData = JSON.parse(startResult.content[0].text);

      const result = await statusTool.execute(client, embed, createContext(startData.session_id), {});

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text);
      expect(data).toHaveProperty('current_session');
      expect(data).toHaveProperty('total_nodes');
    });

    it('kg_status returns working memory overview', async () => {
      const ctx = createContext(null);
      const result = await statusTool.execute(client, embed, ctx, {});

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text);
      expect(data).toHaveProperty('current_session');
      expect(data).toHaveProperty('total_nodes');
      expect(data).toHaveProperty('open_todos');
      expect(data).toHaveProperty('open_problems');
    });
  });

  describe('kg_node_create / kg_node_update', () => {
    let sessionId: string;

    beforeAll(async () => {
      if (skipTests) return;
      const ctx = createContext(null);
      const result = await sessionStartTool.execute(client, embed, ctx, {
        project: 'kg-node-test',
        create_project: true,
      });
      const data = JSON.parse(result.content[0].text);
      sessionId = data.session_id;
    });

    it('kg_node_create creates a new node', async () => {
      const ctx = createContext(sessionId);
      const result = await nodeCreateTool.execute(client, embed, ctx, {
        type: 'decision',
        content: 'Test decision via kg_node_create',
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBe('created');
      expect(data.id).toMatch(/^node:/);
      expect(data.type).toBe('decision');
      expect(data.content).toBe('Test decision via kg_node_create');
    });

    it('kg_node_update updates an existing node', async () => {
      const ctx = createContext(sessionId);
      const createResult = await nodeCreateTool.execute(client, embed, ctx, {
        type: 'problem',
        content: 'Original problem content',
        status: 'open',
      });
      const createData = JSON.parse(createResult.content[0].text);

      const updateResult = await nodeUpdateTool.execute(client, embed, ctx, {
        id: createData.id,
        status: 'resolved',
      });

      expect(updateResult.isError).toBeFalsy();
      const updateData = JSON.parse(updateResult.content[0].text);
      expect(updateData.action).toBe('updated');
      expect(updateData.node.status).toBe('resolved');
    });

    it('kg_node_update returns NOT_FOUND for an unknown node', async () => {
      const ctx = createContext(sessionId);
      const result = await nodeUpdateTool.execute(client, embed, ctx, {
        id: 'node:does_not_exist',
        status: 'resolved',
      });

      expect(result.isError).toBe(true);
    });

    async function storedEmbeddingModel(nodeId: string): Promise<string | undefined> {
      const [rows] = await db.query<[{ embedding_model?: string }[]]>(
        "SELECT embedding_model FROM type::record('node', $id)",
        { id: nodeId.replace(/^node:/, '') }
      );
      return rows[0]?.embedding_model;
    }

    async function storedEmbedding(nodeId: string): Promise<{ embedding?: number[]; embedding_model?: string; content?: string }> {
      const [rows] = await db.query<[{ embedding?: number[]; embedding_model?: string; content?: string }[]]>(
        "SELECT embedding, embedding_model, content FROM type::record('node', $id)",
        { id: nodeId.replace(/^node:/, '') }
      );
      return rows[0];
    }

    function failingProvider(): EmbeddingProvider {
      return {
        ...createFixtureProvider(),
        async embedDocuments(): Promise<number[][]> {
          throw new Error('embedding service down');
        },
      };
    }

    it('kg_node_create records the provider model in embedding_model', async () => {
      const result = await nodeCreateTool.execute(client, createFixtureProvider(), createContext(sessionId), {
        type: 'observation',
        content: 'Embedded by the fixture provider',
      });
      expect(result.isError).toBeFalsy();
      const { id } = JSON.parse(result.content[0].text);

      expect(await storedEmbeddingModel(id)).toBe('fixture');
    });

    it('kg_node_update re-embeds content and records the new provider model', async () => {
      const ctx = createContext(sessionId);
      // Created by another provider (the suite mock), then re-embedded by fixture.
      const created = await nodeCreateTool.execute(client, embed, ctx, {
        type: 'observation',
        content: 'Embedded first by the mock provider',
      });
      const { id } = JSON.parse(created.content[0].text);
      expect(await storedEmbeddingModel(id)).toBe('test-mock');

      const updated = await nodeUpdateTool.execute(client, createFixtureProvider(), ctx, {
        id,
        content: 'Rewritten, re-embedded by the fixture provider',
      });
      expect(updated.isError).toBeFalsy();

      expect(await storedEmbeddingModel(id)).toBe('fixture');
    });

    it('kg_node_update without content keeps embedding_model', async () => {
      const ctx = createContext(sessionId);
      const created = await nodeCreateTool.execute(client, embed, ctx, {
        type: 'problem',
        content: 'Status-only change must not relabel the vector',
        status: 'open',
      });
      const { id } = JSON.parse(created.content[0].text);

      await nodeUpdateTool.execute(client, createFixtureProvider(), ctx, { id, status: 'resolved' });

      expect(await storedEmbeddingModel(id)).toBe('test-mock');
    });

    it('kg_node_update rejects a content change when re-embedding fails and leaves the node untouched', async () => {
      const ctx = createContext(sessionId);
      const created = await nodeCreateTool.execute(client, createFixtureProvider(), ctx, {
        type: 'observation',
        content: 'Content embedded before the outage',
      });
      const { id } = JSON.parse(created.content[0].text);
      const before = await storedEmbedding(id);
      expect(before.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(before.embedding_model).toBe('fixture');

      const updated = await nodeUpdateTool.execute(client, failingProvider(), ctx, {
        id,
        content: 'New content the provider could not embed',
      });
      expect(updated.isError).toBe(true);
      expect(updated.errorCode).toBe('INTERNAL');

      const stored = await storedEmbedding(id);
      expect(stored.content).toBe('Content embedded before the outage');
      expect(stored.embedding).toEqual(before.embedding);
      expect(stored.embedding_model).toBe('fixture');
    });

    it('kg_node_update with only a status change still works while the embedding provider is down', async () => {
      const ctx = createContext(sessionId);
      const created = await nodeCreateTool.execute(client, createFixtureProvider(), ctx, {
        type: 'problem',
        content: 'Status change needs no embedding',
        status: 'open',
      });
      const { id } = JSON.parse(created.content[0].text);

      const updated = await nodeUpdateTool.execute(client, failingProvider(), ctx, { id, status: 'resolved' });
      expect(updated.isError).toBeFalsy();
    });

    it('schemas reject create missing type and update missing id', () => {
      expect(nodeCreateParamsSchema.safeParse({ content: 'Missing type' }).success).toBe(false);
      expect(nodeUpdateParamsSchema.safeParse({ content: 'Missing id' }).success).toBe(false);
    });

    it('kg_status carries no deprecation warning', async () => {
      const ctx = createContext(sessionId);
      const result = await statusTool.execute(client, embed, ctx, {});

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text);
      expect(data).toHaveProperty('total_nodes');
      expect(data._deprecation).toBeUndefined();
    });
  });

  describe('legacy tool names (temporary alias, real database)', () => {
    const legacy = (name: string, ctx: ToolContext, params: Record<string, unknown>) =>
      getLegacyTool(name)!.execute(client, embed, ctx, params);

    it('old kg_session/kg_node/kg_record/kg_update calls still work end to end', async () => {
      const started = await legacy('kg_session', createContext(null), {
        action: 'start',
        project: 'legacy-alias-test',
        create_project: true,
      });
      expect(started.isError).toBeFalsy();
      const sessionId = JSON.parse(started.content[0].text).session_id;
      const ctx = createContext(sessionId);

      const viaNode = await legacy('kg_node', ctx, { action: 'create', type: 'decision', content: 'old kg_node create' });
      const viaRecord = await legacy('kg_record', ctx, { type: 'observation', content: 'old kg_record' });
      expect(viaNode.isError).toBeFalsy();
      expect(viaRecord.isError).toBeFalsy();
      const nodeId = JSON.parse(viaRecord.content[0].text).id;

      const updated = await legacy('kg_update', ctx, { id: nodeId, status: 'resolved' });
      expect(updated.isError).toBeFalsy();
      expect(JSON.parse(updated.content[0].text).node.status).toBe('resolved');

      const info = await legacy('kg_session', ctx, { action: 'info' });
      expect(JSON.parse(info.content[0].text).current_session.session_id).toBe(sessionId);

      const ended = await legacy('kg_session', ctx, { action: 'end' });
      expect(JSON.parse(ended.content[0].text).action).toBe('ended');
    });
  });
});
