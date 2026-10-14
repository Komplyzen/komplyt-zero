import { z } from 'zod';
import {
  ToolHandler,
  SessionEndParams,
  sessionEndParamsSchema,
  sessionEndResponseSchema,
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
import { resolveActiveSession } from './session-core.js';

type Session = SessionRecord;

async function endSession(db: KgDbClient, tenantId: string): Promise<ToolResult> {
  // CRITICAL: Filter by tenant to prevent cross-tenant session manipulation
  // (resolveActiveSession's query already enforces this).
  const openSession = await resolveActiveSession(db, tenantId);

  if (!openSession) {
    return toolError('NO_SESSION', 'No active session. Start a session first with kg_session_start.');
  }

  const updated = await db.queryOne<Session & { project_name?: string; tenant_name?: string }>(
    `SELECT *, project.name AS project_name, tenant.name AS tenant_name FROM (UPDATE type::record('session', $session_id) SET ended_at = time::now() RETURN AFTER)`,
    { session_id: extractRecordId(openSession.id, 'session') }
  );

  if (!updated) {
    return toolError('INTERNAL', 'Failed to end session');
  }

  return toolSuccess({
    action: 'ended',
    session_id: normalizeRecordId(updated.id),
    session_number: updated.session_num,
    started_at: updated.started_at ?? '',
    ended_at: updated.ended_at ?? '',
    project: updated.project_name,
    tenant: updated.tenant_name,
  });
}

export const sessionEndTool: ToolHandler<SessionEndParams> = {
  name: 'kg_session_end',
  description: 'End the current session. Nodes and edges are kept; a new session must be started before further writes.',
  inputSchema: sessionEndParamsSchema as z.ZodType<SessionEndParams>,
  responseSchema: sessionEndResponseSchema,
  requiredScope: 'kg:write',
  annotations: {
    title: 'End Session',
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },

  async execute(
    db: KgDbClient,
    _embed: EmbeddingProvider,
    ctx: ToolContext
  ): Promise<ToolResult> {
    return endSession(db, ctx.tenantId);
  },
};
