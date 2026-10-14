import {
  ToolHandler,
  StatusParams,
  statusParamsSchema,
  statusResponseSchema,
  KgDbClient,
  EmbeddingProvider,
  ToolContext,
  ToolResult,
  toolSuccess,
  toolError,
  NodeDbRow,
  nodeToResponse,
} from '../contracts.js';
import { resolveActiveSession } from './session-core.js';

async function getStatus(db: KgDbClient, tenantId: string, project?: string): Promise<ToolResult> {
  const sessionInfo = await resolveActiveSession(db, tenantId);
  const currentSession = sessionInfo?.session_num ?? 0;

  const fetchOpenTodos = async (): Promise<NodeDbRow[]> => {
    const query = project
      ? `SELECT *, project.name AS project_name, author.name AS author_name, tenant.name AS tenant_name FROM node
         WHERE type = 'todo' AND status = 'open' AND tenant = type::record('tenant', $tenant_id) AND project.name = $project
         ORDER BY session_activated DESC LIMIT 10`
      : `SELECT *, project.name AS project_name, author.name AS author_name, tenant.name AS tenant_name FROM node
         WHERE type = 'todo' AND status = 'open' AND tenant = type::record('tenant', $tenant_id)
         ORDER BY session_activated DESC LIMIT 10`;
    return db.query<NodeDbRow>(query, project ? { project, tenant_id: tenantId } : { tenant_id: tenantId });
  };

  const fetchOpenProblems = async (): Promise<NodeDbRow[]> => {
    const query = project
      ? `SELECT *, project.name AS project_name, author.name AS author_name, tenant.name AS tenant_name FROM node
         WHERE type = 'problem' AND (status = 'open' OR status = 'blocked') AND tenant = type::record('tenant', $tenant_id) AND project.name = $project
         ORDER BY session_activated DESC LIMIT 10`
      : `SELECT *, project.name AS project_name, author.name AS author_name, tenant.name AS tenant_name FROM node
         WHERE type = 'problem' AND (status = 'open' OR status = 'blocked') AND tenant = type::record('tenant', $tenant_id)
         ORDER BY session_activated DESC LIMIT 10`;
    return db.query<NodeDbRow>(query, project ? { project, tenant_id: tenantId } : { tenant_id: tenantId });
  };

  const fetchRecentDecisions = async (): Promise<NodeDbRow[]> => {
    const minSession = Math.max(0, currentSession - 3);
    const query = project
      ? `SELECT *, project.name AS project_name, author.name AS author_name, tenant.name AS tenant_name FROM node
         WHERE type = 'decision' AND tenant = type::record('tenant', $tenant_id) AND session_activated.session_num >= $min_session AND project.name = $project
         ORDER BY session_activated.session_num DESC LIMIT 10`
      : `SELECT *, project.name AS project_name, author.name AS author_name, tenant.name AS tenant_name FROM node
         WHERE type = 'decision' AND tenant = type::record('tenant', $tenant_id) AND session_activated.session_num >= $min_session
         ORDER BY session_activated.session_num DESC LIMIT 10`;
    const queryParams: Record<string, unknown> = { min_session: minSession, tenant_id: tenantId };
    if (project) queryParams.project = project;
    return db.query<NodeDbRow>(query, queryParams);
  };

  const fetchRecentApproaches = async (): Promise<NodeDbRow[]> => {
    const minSession = Math.max(0, currentSession - 5);
    const query = project
      ? `SELECT *, project.name AS project_name, author.name AS author_name, tenant.name AS tenant_name FROM node
         WHERE type = 'approach' AND tenant = type::record('tenant', $tenant_id) AND session_activated.session_num >= $min_session AND project.name = $project
         ORDER BY session_activated.session_num DESC LIMIT 5`
      : `SELECT *, project.name AS project_name, author.name AS author_name, tenant.name AS tenant_name FROM node
         WHERE type = 'approach' AND tenant = type::record('tenant', $tenant_id) AND session_activated.session_num >= $min_session
         ORDER BY session_activated.session_num DESC LIMIT 5`;
    const queryParams: Record<string, unknown> = { min_session: minSession, tenant_id: tenantId };
    if (project) queryParams.project = project;
    return db.query<NodeDbRow>(query, queryParams);
  };

  const countNodes = async (): Promise<number> => {
    const query = project
      ? "SELECT count() FROM node WHERE tenant = type::record('tenant', $tenant_id) AND project.name = $project GROUP ALL"
      : "SELECT count() FROM node WHERE tenant = type::record('tenant', $tenant_id) GROUP ALL";
    const result = await db.queryOne<{ count: number }>(query, project ? { project, tenant_id: tenantId } : { tenant_id: tenantId });
    return result?.count ?? 0;
  };

  // Verify project exists if specified
  if (project) {
    const existing = await db.queryOne<{ id: string }>(
      "SELECT id FROM project WHERE name = $name AND tenant = type::record('tenant', $tenant_id)",
      { name: project, tenant_id: tenantId }
    );
    if (!existing) {
      const available = await db.query<{ name: string }>(
        "SELECT name FROM project WHERE tenant = type::record('tenant', $tenant_id)",
        { tenant_id: tenantId }
      );
      const names = available.map(p => p.name).join(', ') || '(none)';
      return toolError('NOT_FOUND', `Project '${project}' not found. Available: ${names}`);
    }
  }

  const [openTodos, openProblems, recentDecisions, recentApproaches, totalNodes] =
    await Promise.all([
      fetchOpenTodos(),
      fetchOpenProblems(),
      fetchRecentDecisions(),
      fetchRecentApproaches(),
      countNodes(),
    ]);

  return toolSuccess({
    current_session: currentSession,
    session_active: sessionInfo ? true : undefined,
    session_started: sessionInfo?.started_at,
    session_project: sessionInfo?.project_name,
    total_nodes: totalNodes,
    open_todos: openTodos.map(nodeToResponse),
    open_problems: openProblems.map(nodeToResponse),
    recent_decisions: recentDecisions.map(nodeToResponse),
    recent_approaches: recentApproaches.map(nodeToResponse),
  });
}

export const statusTool: ToolHandler<StatusParams> = {
  name: 'kg_status',
  description: 'Get an overview of current working memory: open todos and problems, recent decisions and approaches, node count, and active session info. Read-only. Optionally filter by project.',
  inputSchema: statusParamsSchema,
  responseSchema: statusResponseSchema,
  requiredScope: 'kg:read',
  annotations: {
    title: 'Get Status',
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },

  async execute(
    db: KgDbClient,
    _embed: EmbeddingProvider,
    ctx: ToolContext,
    params: StatusParams
  ): Promise<ToolResult> {
    return getStatus(db, ctx.tenantId, params.project);
  },
};
