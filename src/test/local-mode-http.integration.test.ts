/**
 * KG_AUTH_MODE=local over HTTP, end to end: a /mcp request with no Authorization
 * header starts a session and creates a node, and the node lands in the local tenant, through the
 * same kg_server signin and RLS as a verified Komplyt token.
 *
 * The mode is read from the process environment when env.ts loads, so it is set in vi.hoisted,
 * before any import. Nothing else in this file changes the environment.
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.KG_AUTH_MODE = 'local';
  process.env.KG_LOCAL_SUB = 'self-hoster';
  process.env.KG_LOCAL_TENANT = 'my-lab';
  delete process.env.KOMPLYT_JWKS_URL;
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Surreal } from 'surrealdb';
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from '../contracts.js';
import { pooledDbFactory, gracefulShutdown } from '../pool.js';
import { toolRegistry } from '../tools/index.js';
import { createMcpRoutes, resetRateLimits } from '../mcp.js';
import { connectTestDb, wipeData } from './connect.js';

let rootDb: Surreal;

const embed: EmbeddingProvider = {
  embedDocuments: async (texts) => texts.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0.01)),
  embedQuery: async () => new Array(EMBEDDING_DIMENSIONS).fill(0.01),
  model: 'test-fixture',
  dimensions: EMBEDDING_DIMENSIONS,
};

describe('local auth mode over HTTP', () => {
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
    resetRateLimits();
  });

  afterAll(async () => {
    await gracefulShutdown();
    await rootDb?.close();
  });

  const app = () => {
    const a = new Hono();
    a.route('/mcp', createMcpRoutes({ dbFactory: pooledDbFactory, embed, toolRegistry }));
    return a;
  };

  // No Authorization header anywhere in this file.
  const call = async (name: string, args: Record<string, unknown>, id: number) => {
    const res = await app().request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    return res.json();
  };

  it('starts a session and creates a node without any token, in the local tenant', async () => {
    const started = await call('kg_session_start', { project: 'demo', create_project: true }, 1);
    expect(started.result?.isError, JSON.stringify(started)).toBeFalsy();

    const created = await call('kg_node_create', { type: 'observation', content: 'written without a token' }, 2);
    expect(created.result?.isError, JSON.stringify(created)).toBeFalsy();

    const rows = await rootDb.query<Array<Array<{ tenant: unknown; author: unknown }>>>(
      `SELECT tenant, author FROM node WHERE content = 'written without a token'`
    );
    expect(rows[0]).toHaveLength(1);
    expect(String(rows[0][0].tenant)).toContain('my-lab');
    expect(String(rows[0][0].author)).toContain('self-hoster');
  });

  it('tools/list works without a token', async () => {
    const res = await app().request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.tools.length).toBeGreaterThan(0);
  });
});
