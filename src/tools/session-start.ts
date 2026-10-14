import { z } from 'zod';
import {
  ToolHandler,
  SessionStartParams,
  sessionStartParamsSchema,
  sessionStartResponseSchema,
  KgDbClient,
  EmbeddingProvider,
  ToolContext,
  ToolResult,
  toolSuccess,
  toolError,
  extractRecordId,
  normalizeRecordId,
  SessionRecord,
} from '../contracts.js';
import { applySessionDecay } from '../activation.js';
import { childLogger } from '../logger.js';
import { DefaultContainerDeletedError, ensureDefaultContainer } from './default-container.js';

const logger = childLogger('session-start');

type Session = SessionRecord;

async function getNextSessionNum(db: KgDbClient, tenantId: string): Promise<number> {
  // Filter by tenant so session numbers are tenant-scoped
  // SELECT VALUE returns bare number, not {session_num: number}
  const result = await db.queryOne<number>(
    "SELECT VALUE session_num FROM session WHERE tenant = type::record('tenant', $tenant_id) ORDER BY session_num DESC LIMIT 1",
    { tenant_id: tenantId }
  );
  return (result ?? 0) + 1;
}

/**
 * Resolve project by name within tenant scope.
 * RLS at the DB layer enforces that queries only see the caller's tenant data.
 */
async function resolveProject(
  db: KgDbClient,
  projectName: string | undefined,
  tenantId: string,
  createIfMissing: boolean
): Promise<{ ref: string | null; error: string | null }> {
  if (!projectName) {
    return { ref: null, error: null };
  }

  const existing = await db.queryOne<{ id: string }>(
    "SELECT id FROM project WHERE name = $name AND tenant = type::record('tenant', $tenant_id)",
    { name: projectName, tenant_id: tenantId }
  );

  if (existing) {
    return { ref: existing.id, error: null };
  }

  if (createIfMissing) {
    logger.info({ projectName, tenantId }, 'create_project: starting');

    // A tenant's first project also provisions its default container (first-use provisioning).
    try {
      await ensureDefaultContainer(db, tenantId);
    } catch (err) {
      if (err instanceof DefaultContainerDeletedError) {
        return { ref: null, error: 'The default container was deleted and is awaiting purge; no project was created.' };
      }
      throw err;
    }

    const query = `CREATE project SET name = $name, tenant = type::record('tenant', $tenant_id) RETURN id`;
    const params = { name: projectName, tenant_id: tenantId };
    logger.info({ query, params }, 'create_project: executing CREATE');

    const created = await db.queryOne<{ id: string }>(query, params);
    logger.info({ created }, 'create_project: CREATE result');

    return { ref: created?.id ?? null, error: null };
  }

  const available = await db.query<{ name: string }>(
    "SELECT name FROM project WHERE tenant = type::record('tenant', $tenant_id)",
    { tenant_id: tenantId }
  );
  const names = available.map(p => p.name).join(', ') || '(none)';
  return { ref: null, error: `Project '${projectName}' not found. Available: ${names}` };
}

async function startSession(
  db: KgDbClient,
  ctx: ToolContext,
  params: SessionStartParams
): Promise<ToolResult> {
  const sessionNum = await getNextSessionNum(db, ctx.tenantId);

  const projectResult = await resolveProject(
    db,
    params.project,
    ctx.tenantId,
    params.create_project ?? false
  );

  if (projectResult.error) {
    return toolError('INVALID_INPUT', projectResult.error);
  }

  // Build query dynamically - omit optional fields if undefined (SurrealDB NONE vs NULL distinction)
  const hasNotes = params.notes !== undefined && params.notes !== null;
  const hasProject = projectResult.ref !== null;

  const query = `CREATE session SET
    ${hasProject ? "project = type::record('project', $project_id)," : ''}
    tenant = type::record('tenant', $tenant_id),
    ${hasNotes ? 'notes = $notes,' : ''}
    session_num = $session_num
  RETURN AFTER`;

  const queryParams: Record<string, unknown> = {
    tenant_id: ctx.tenantId,
    session_num: sessionNum,
  };
  if (hasProject) {
    queryParams.project_id = extractRecordId(projectResult.ref!, 'project');
  }
  if (hasNotes) {
    queryParams.notes = params.notes;
  }

  const created = await db.queryOne<Session>(query, queryParams);

  if (!created?.id) {
    return toolError('INTERNAL', 'Failed to create session');
  }

  const nodesDecayed = await applySessionDecay(
    db,
    created.id,
    ctx.tenantId,
    params.project
  );

  return toolSuccess({
    action: 'started',
    session_id: normalizeRecordId(created.id),
    session_number: sessionNum,
    project: params.project,
    tenant: ctx.tenantId,
    notes: params.notes,
    nodes_decayed: nodesDecayed,
  });
}

export const sessionStartTool: ToolHandler<SessionStartParams> = {
  name: 'kg_session_start',
  description: 'Start a new working-memory session. Required before creating nodes or edges. Applies decay to the usage-based scores of existing nodes (node content is not changed), and can optionally create the named project (plus the default workspace records on first use) if it does not exist.',
  inputSchema: sessionStartParamsSchema as z.ZodType<SessionStartParams>,
  responseSchema: sessionStartResponseSchema,
  requiredScope: 'kg:write',
  annotations: {
    title: 'Start Session',
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },

  async execute(
    db: KgDbClient,
    _embed: EmbeddingProvider,
    ctx: ToolContext,
    params: SessionStartParams
  ): Promise<ToolResult> {
    return startSession(db, ctx, params);
  },
};
