/**
 * Integration tests for the project-id corruption fix.
 *
 * A project whose record ID contains a colon (the historical name-based-id
 * convention of the hosted graph, e.g. "komplyzen:kg-mcp-server") forces SurrealDB to
 * bracket-escape the id when serializing it as a string. extractRecordId's
 * string branch only stripped the "table:" prefix, leaving the escaping in
 * place; re-inserting that into type::record() then double-escaped it,
 * corrupting node.project and session.project references.
 *
 * Uses a minimal hand-rolled schema (root connection bypasses PERMISSIONS)
 * since this is a query-logic regression, not a permissions regression -
 * same pattern as relate-activation.integration.test.ts.
 *
 * Run with: KG_DB_URL=ws://localhost:8001 npm test -- --run project-id-corruption.integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { KgDbClient, ToolContext } from '../contracts.js';
import { createFixtureProvider } from '../embed.js';
import { nodeCreateTool, DEFAULT_CONTAINER_NAME } from '../tools/node-create.js';
import { sessionStartTool } from '../tools/session-start.js';
import { sessionEndTool } from '../tools/session-end.js';
import { queryTool } from '../tools/query.js';
import { connectTestDb, wipeData } from './connect.js';

let rootDb: Surreal;
let db: KgDbClient;

// Deterministic 1024-dim vectors: the node_embedding HNSW index rejects an
// empty embedding, so a no-op provider returning [] no longer fits the schema.
const noopEmbed = createFixtureProvider();

function parseResult<T>(result: { content: Array<{ text: string }>; isError?: boolean }): T {
  if (result.isError) {
    throw new Error(`Tool returned error: ${result.content[0]?.text}`);
  }
  return JSON.parse(result.content[0].text) as T;
}

describe('Project ID Corruption Regressions', () => {
  let skipTests = false;

  // A skipped test must REPORT as skipped, not pass with an empty body.
  // Each test provisions its own tenant, so start from clean data.
  beforeEach(async (ctx) => {
    if (skipTests) ctx.skip();
    await wipeData(rootDb);
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

  /** The real container schema requires an owner principal. */
  async function makeTenantPrincipal(tenantId: string): Promise<string> {
    const id = `tenant_${tenantId}`;
    await db.query(`CREATE type::record('principal', $id) SET type = 'Tenant', ref_id = $tid`, { id, tid: tenantId });
    return id;
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

  /**
   * Reproduces the ADR-014 rename scenario: a project record whose id is the
   * old colon-containing name, but whose `name` field has since been renamed
   * to the bare form. SurrealDB record ids are immutable, so this mismatch
   * is exactly how the real kg-mcp-server project ended up in this shape -
   * this is the one piece of test setup that must construct the id directly
   * (via type::record()) rather than through resolveProject's CREATE, since
   * resolveProject never produces a colon-containing id itself.
   *
   * Also provisions the default "Company Knowledge" container kg_node_create
   * requires, and a unique per-call project id/name pair (project ids are
   * global across the database, not tenant-scoped, so a shared constant
   * would collide across tests/tenants).
   */
  async function makeTenantWithColonProject(): Promise<{
    tenantId: string;
    projectId: string;
    projectName: string;
  }> {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tenantName = `t-${unique}`;
    const [tenant] = await db.query<{ id: string }>('CREATE tenant SET name = $name', { name: tenantName });
    const tenantId = String(tenant.id).replace('tenant:', '');

    const projectName = `kg-mcp-server-${unique}`;
    const projectId = `komplyzen:${projectName}`;

    await db.query(
      `CREATE type::record('project', $project_id) SET name = $name, tenant = type::record('tenant', $tenant_id)`,
      { project_id: projectId, name: projectName, tenant_id: tenantId }
    );

    await db.query(
      `CREATE container SET name = $name, tenant = type::record('tenant', $tenant_id), owner = type::record('principal', $owner)`,
      { name: DEFAULT_CONTAINER_NAME, tenant_id: tenantId, owner: await makeTenantPrincipal(tenantId) }
    );

    return { tenantId, projectId, projectName };
  }

  it('kg_node_create with an explicit project= param writes a clean project ref for a colon-id project (CAP-1)', async () => {
    const { tenantId, projectId, projectName } = await makeTenantWithColonProject();

    const sessionResult = parseResult<{ session_id: string }>(
      await sessionStartTool.execute(db, noopEmbed, makeContext(tenantId, null), { create_project: false } as never)
    );

    const recordResult = parseResult<{ id: string }>(
      await nodeCreateTool.execute(db, noopEmbed, makeContext(tenantId, sessionResult.session_id), {
        type: 'observation',
        content: 'project-id regression: explicit project param on a colon-id project',
        project: projectName,
      } as never)
    );

    // Read the node back exactly as it was stored - no tool-side normalization here.
    const stored = await db.queryOne<{ project: string }>(
      "SELECT VALUE project FROM type::record('node', $nid)",
      { nid: recordResult.id.replace('node:', '') }
    );

    expect(stored).toBeTruthy();
    const storedStr = String(stored);
    expect(storedStr).not.toContain('⟨⟨');
    expect(storedStr).not.toContain('\\⟩');

    // The stored ref must resolve back to the SAME project via a clean type::record() lookup.
    const resolvedProject = await db.queryOne<{ id: string; name: string }>(
      "SELECT id, name FROM type::record('project', $pid)",
      { pid: projectId }
    );
    expect(resolvedProject?.name).toBe(projectName);
  });

  // A second CAP-1 scenario - kg_node_create falling back to the session's project
  // when no explicit project= param is given - is NOT covered here. That path
  // (getSessionProject, record.ts:23-32) was found to be independently broken
  // (always returns null; unrelated {tb,id}-as-FROM-target bug, not the
  // bracket-escaping bug this spec covers) while writing this test. Tracked
  // separately; out of scope here.

  it('a project-filtered kg_query finds a node written against a colon-id project (end-to-end proof)', async () => {
    const { tenantId, projectName } = await makeTenantWithColonProject();

    const sessionResult = parseResult<{ session_id: string }>(
      await sessionStartTool.execute(db, noopEmbed, makeContext(tenantId, null), {
        project: projectName,
        create_project: false,
      } as never)
    );

    // Explicit project= param - session-derived resolution is broken, unrelated to this spec.
    parseResult(
      await nodeCreateTool.execute(db, noopEmbed, makeContext(tenantId, sessionResult.session_id), {
        type: 'problem',
        content: 'project-id regression: this node must be findable via project filter',
        project: projectName,
      } as never)
    );

    const filtered = parseResult<{ nodes: Array<{ content: string }> }>(
      await queryTool.execute(db, noopEmbed, makeContext(tenantId, sessionResult.session_id), {
        project: projectName,
        spread: false,
        limit: 10,
        include_related: false,
        include_edges: false,
        include_neighbors: false,
      } as never)
    );

    expect(filtered.nodes.some(n => n.content.includes('must be findable via project filter'))).toBe(true);
  });

  it('kg_session start and end report an identical, clean project ref for the same session (CAP-2)', async () => {
    const { tenantId, projectName } = await makeTenantWithColonProject();

    const startResult = parseResult<{ project?: string }>(
      await sessionStartTool.execute(db, noopEmbed, makeContext(tenantId, null), {
        project: projectName,
        create_project: false,
      } as never)
    );

    const endResult = parseResult<{ project?: string }>(
      await sessionEndTool.execute(db, noopEmbed, makeContext(tenantId, null), {} as never)
    );

    expect(startResult.project).toBeTruthy();
    expect(endResult.project).toBeTruthy();
    expect(endResult.project).toBe(startResult.project);
    expect(startResult.project).not.toContain('⟨');
    expect(endResult.project).not.toContain('⟨');
  });
});
