/**
 * The stdio CLI in local auth mode on a fresh database, with no credentials.
 *
 * Drives the same path bin/mcp.ts uses: resolveStdioClaims for the identity, then
 * executeStdioToolCallScoped over the pooled factory. The credential loader throws, so the test
 * fails if the local path ever reaches for ~/.kg/credentials.json.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider, type KgTokenPayload } from '../contracts.js';
import { pooledDbFactory, gracefulShutdown } from '../pool.js';
import { toolRegistry } from '../tools/index.js';
import { executeStdioToolCallScoped } from '../bin/stdio-tool-call.js';
import { resolveStdioClaims } from '../bin/stdio-claims.js';
import { connectTestDb, wipeData } from './connect.js';

let rootDb: Surreal;

const embed: EmbeddingProvider = {
  embedDocuments: async (texts) => texts.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0.01)),
  embedQuery: async () => new Array(EMBEDDING_DIMENSIONS).fill(0.01),
  model: 'test-fixture',
  dimensions: EMBEDDING_DIMENSIONS,
};

describe('stdio CLI in local mode', () => {
  let skipTests = false;
  let claims: KgTokenPayload;

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
    claims = await resolveStdioClaims(
      { KG_AUTH_MODE: 'local', KG_LOCAL_SUB: 'local', KG_LOCAL_TENANT: 'local' },
      async () => {
        throw new Error('credentials must not be read in local mode');
      }
    );
  });

  afterAll(async () => {
    await gracefulShutdown();
    await rootDb?.close();
  });

  const run = (name: string, args: unknown, session: string | null) =>
    executeStdioToolCallScoped({ registry: toolRegistry, dbFactory: pooledDbFactory, embed, claims }, name, args, session);

  it('starts a session and creates a node on a fresh database, in the local tenant', async () => {
    const started = await run('kg_session_start', { project: 'demo', create_project: true }, null);
    expect(started.isError, started.content[0]?.text).toBeFalsy();
    expect(started.sessionId).toBeTruthy();

    const created = await run('kg_node_create', { type: 'observation', content: 'hello from local mode' }, started.sessionId);
    expect(created.isError, created.content[0]?.text).toBeFalsy();

    const nodes = await rootDb.query<Array<Array<{ content: string; tenant: unknown }>>>(
      `SELECT content, tenant FROM node WHERE content = 'hello from local mode'`
    );
    expect(nodes[0]).toHaveLength(1);
    expect(String(nodes[0][0].tenant)).toContain('local');

    const containers = await rootDb.query<Array<Array<{ name: string }>>>(
      `SELECT name FROM container WHERE tenant = type::record('tenant', 'local')`
    );
    expect(containers[0].map((c) => c.name)).toEqual(['Company Knowledge']);
  });

  it('can read back what it wrote', async () => {
    const started = await run('kg_session_start', { project: 'demo' }, null);
    const queried = await run('kg_query', { text: 'hello from local mode' }, started.sessionId);
    expect(queried.isError, queried.content[0]?.text).toBeFalsy();
    expect(queried.content[0].text).toContain('hello from local mode');
  });
});
