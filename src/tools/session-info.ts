import { z } from 'zod';
import {
  ToolHandler,
  SessionInfoParams,
  sessionInfoParamsSchema,
  sessionInfoResponseSchema,
  KgDbClient,
  EmbeddingProvider,
  ToolContext,
  ToolResult,
  toolSuccess,
  normalizeRecordId,
} from '../contracts.js';
import { resolveActiveSession } from './session-core.js';

interface TypeCount {
  type: string;
  count: number;
}

async function getSessionInfo(db: KgDbClient, tenantId: string): Promise<ToolResult> {
  // CRITICAL: Filter by tenant to prevent cross-tenant session info disclosure
  // (resolveActiveSession's query already enforces this).
  const currentSession = await resolveActiveSession(db, tenantId);

  // CRITICAL: Filter node counts by tenant
  const stats = await db.query<TypeCount>(
    "SELECT type, count() as count FROM node WHERE tenant = type::record('tenant', $tenant_id) GROUP BY type",
    { tenant_id: tenantId }
  );

  const nodeCounts: Record<string, number> = {};
  for (const s of stats) {
    nodeCounts[s.type] = s.count;
  }

  const sessionInfo = currentSession
    ? {
        session_id: normalizeRecordId(currentSession.id),
        session_number: currentSession.session_num,
        started_at: currentSession.started_at,
        // Always undefined post-currentSession only ever comes from
        // resolveActiveSession, which filters ended_at IS NONE - kept in the
        // response shape for schema stability, not because this path can
        // ever populate it.
        ended_at: currentSession.ended_at,
        project: currentSession.project_name,
        tenant: currentSession.tenant_name,
        notes: currentSession.notes,
      }
    : undefined;

  return toolSuccess({
    session_number: currentSession?.session_num ?? 0,
    current_session: sessionInfo,
    node_counts: nodeCounts,
  });
}

export const sessionInfoTool: ToolHandler<SessionInfoParams> = {
  name: 'kg_session_info',
  description: 'Get details of the current session (number, start time, project, notes) and node counts by type. Read-only.',
  inputSchema: sessionInfoParamsSchema as z.ZodType<SessionInfoParams>,
  responseSchema: sessionInfoResponseSchema,
  requiredScope: 'kg:read',
  annotations: {
    title: 'Get Session Info',
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },

  async execute(
    db: KgDbClient,
    _embed: EmbeddingProvider,
    ctx: ToolContext
  ): Promise<ToolResult> {
    return getSessionInfo(db, ctx.tenantId);
  },
};
