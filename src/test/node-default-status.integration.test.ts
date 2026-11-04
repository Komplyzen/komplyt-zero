/**
 * kg_node_create without a status: problem and todo start `open`, because kg_status lists only open
 * todos and open or blocked problems, so a node stored without a status would never appear there.
 * Other types keep no status; an explicit status always wins. State is created through the real
 * tools and read back through kg_status and the stored row.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { nodeCreateTool } from '../tools/node-create.js';
import { sessionStartTool } from '../tools/session-start.js';
import { statusTool } from '../tools/status.js';
import {
  KgDbClient,
  ToolContext,
  KgTokenPayload,
  EmbeddingProvider,
  EMBEDDING_DIMENSIONS,
} from '../contracts.js';
import { connectTestDb, wipeData } from './connect.js';

function createFixedEmbed(): EmbeddingProvider {
  return {
    model: 'test-fixed',
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
  const query = async <T>(sql: string, vars?: Record<string, unknown>): Promise<T[]> => {
    const results = await db.query<T[][]>(sql, vars);
    return results.flat();
  };
  return {
    query,
    async queryOne<T>(sql: string, vars?: Record<string, unknown>): Promise<T | null> {
      return (await query<T>(sql, vars))[0] ?? null;
    },
    async close(): Promise<void> {
      await db.close();
    },
  };
}

describe('kg_node_create default status', () => {
  let db: Surreal;
  let client: KgDbClient;
  let embed: EmbeddingProvider;
  let skipTests = false;
  let sessionId: string;
  const tenantId = `test_tenant_status_${Date.now()}`;
  const project = 'default-status';

  beforeEach((ctx) => {
    if (skipTests) ctx.skip();
  });

  function createContext(session: string | null): ToolContext {
    const claims: KgTokenPayload = {
      sub: 'test-user',
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
    embed = createFixedEmbed();

    const principalId = `tenant_${tenantId}`;
    await db.query(`CREATE type::record('tenant', $tenant_id) SET name = $tenant_id`, { tenant_id: tenantId });
    await db.query(`CREATE type::record('principal', $principal_id) SET type = 'Tenant', ref_id = $tenant_id`, {
      principal_id: principalId,
      tenant_id: tenantId,
    });
    await db.query(
      `CREATE type::record('container', $container_id) SET
        name = 'Company Knowledge',
        tenant = type::record('tenant', $tenant_id),
        owner = type::record('principal', $principal_id),
        granted_principals = [type::record('principal', $principal_id)]`,
      { container_id: `${tenantId}_default`, tenant_id: tenantId, principal_id: principalId },
    );

    const started = await sessionStartTool.execute(client, embed, createContext(null), { project, create_project: true });
    sessionId = JSON.parse(started.content[0].text).session_id;
  });

  afterAll(async () => {
    await db?.close();
  });

  async function create(type: string, content: string, status?: string) {
    const result = await nodeCreateTool.execute(client, embed, createContext(sessionId), {
      type: type as never,
      content,
      ...(status ? { status: status as never } : {}),
    });
    expect(result.isError, result.content[0].text).toBeFalsy();
    return JSON.parse(result.content[0].text) as { id: string; status?: string };
  }

  async function overview() {
    const result = await statusTool.execute(client, embed, createContext(sessionId), { project });
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0].text) as {
      open_todos: Array<{ id: string; status?: string }>;
      open_problems: Array<{ id: string; status?: string }>;
    };
  }

  async function storedStatus(id: string): Promise<string | null | undefined> {
    const row = await client.queryOne<{ status?: string | null }>(`SELECT status FROM type::record($id)`, { id });
    return row?.status;
  }

  it('a problem created without a status is stored open and listed by kg_status', async () => {
    const created = await create('problem', 'Build fails behind a TLS proxy');
    expect(created.status).toBe('open');
    expect(await storedStatus(created.id)).toBe('open');
    const { open_problems } = await overview();
    expect(open_problems.map((n) => n.id)).toContain(created.id);
  });

  it('a todo created without a status is stored open and listed by kg_status', async () => {
    const created = await create('todo', 'Publish the prebuilt image');
    expect(created.status).toBe('open');
    expect(await storedStatus(created.id)).toBe('open');
    const { open_todos } = await overview();
    expect(open_todos.map((n) => n.id)).toContain(created.id);
  });

  it.each(['observation', 'decision', 'argument', 'mitigation', 'workaround', 'approach'])('a %s created without a status keeps none', async (type) => {
    const created = await create(type, `A ${type} without status`);
    expect(created.status).toBeUndefined();
    expect(await storedStatus(created.id)).toBeFalsy();
  });

  it('an explicit status on a todo is stored unchanged: done and blocked todos are not listed as open', async () => {
    const done = await create('todo', 'Cut release 1.0.3', 'done');
    const blocked = await create('todo', 'Verify the permission gate on a PR', 'blocked');
    expect(await storedStatus(done.id)).toBe('done');
    expect(await storedStatus(blocked.id)).toBe('blocked');
    const { open_todos } = await overview();
    const ids = open_todos.map((n) => n.id);
    expect(ids).not.toContain(done.id);
    expect(ids).not.toContain(blocked.id);
  });

  it('an explicit status is stored unchanged: resolved is not listed, blocked still is', async () => {
    const resolved = await create('problem', 'Already fixed upstream', 'resolved');
    const blocked = await create('problem', 'Waiting for the registry', 'blocked');
    expect(resolved.status).toBe('resolved');
    expect(await storedStatus(resolved.id)).toBe('resolved');
    expect(await storedStatus(blocked.id)).toBe('blocked');
    const { open_problems } = await overview();
    const ids = open_problems.map((n) => n.id);
    expect(ids).not.toContain(resolved.id);
    expect(ids).toContain(blocked.id);
  });
});
