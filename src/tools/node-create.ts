import {
  ToolHandler,
  NodeCreateParams,
  nodeCreateParamsSchema,
  nodeCreateResponseSchema,
  KgDbClient,
  EmbeddingProvider,
  ToolContext,
  ToolResult,
  toolSuccess,
  toolError,
  extractRecordId,
} from '../contracts.js';
import { childLogger } from '../logger.js';
import { DefaultContainerDeletedError, ensureDefaultContainer } from './default-container.js';

const logger = childLogger('node-create');

export { DEFAULT_CONTAINER_NAME } from './default-container.js';

/** Max edges that can be created via relates_to in a single kg_node_create call */
const RELATES_TO_LIMIT = 20;

interface CreatedNode {
  id: string;
}

interface SessionProjectInfo {
  project_id: string;
  project_name: string;
}

async function getSessionProject(
  db: KgDbClient,
  sessionId: string
): Promise<SessionProjectInfo | null> {
  const result = await db.queryOne<{ project: string; project_name: string }>(
    "SELECT project, project.name AS project_name FROM type::record('session', $session_id)",
    { session_id: extractRecordId(sessionId, 'session') }
  );
  if (!result?.project || !result?.project_name) return null;
  return {
    project_id: extractRecordId(result.project, 'project'),
    project_name: result.project_name,
  };
}

async function createNode(
  db: KgDbClient,
  embed: EmbeddingProvider,
  ctx: ToolContext,
  params: NodeCreateParams
): Promise<ToolResult> {
  if (!ctx.currentSession) {
    return toolError('NO_SESSION', 'No active session. Start a session first with kg_session_start.');
  }

  const content = params.content.trim();
  if (content.length === 0) {
    return toolError('INVALID_INPUT', 'Content cannot be empty or whitespace-only');
  }

  // Validate relates_to limit early, before creating the node
  // Limit is per-call (20), distinct from kg_relate's per-session limit (100).
  // Per-call limit prevents accidental bulk edge creation; kg_relate is the
  // explicit tool for larger edge operations with session-level rate limiting.
  let uniqueTargets: string[] = [];
  if (params.relates_to && params.relates_to.length > 0) {
    uniqueTargets = [...new Set(params.relates_to)];
    if (uniqueTargets.length > RELATES_TO_LIMIT) {
      return toolError(
        'INVALID_INPUT',
        `relates_to exceeds limit of ${RELATES_TO_LIMIT} targets (got ${uniqueTargets.length}). Use kg_relate for bulk edge creation.`
      );
    }
  }

  // A node without a vector would be invisible to semantic search, so a failed
  // embedding fails the create; the caller can retry.
  let embedding: number[];
  try {
    const [emb] = await embed.embedDocuments([params.content]);
    embedding = emb;
  } catch (e) {
    logger.warn({ err: e }, 'Failed to generate embedding');
    return toolError('INTERNAL', 'Could not generate the embedding for this node; nothing was saved. Please retry.');
  }

  let projectId: string;
  let projectName: string;
  if (params.project) {
    const project = await db.queryOne<{ id: string }>(
      `SELECT id FROM project WHERE name = $name AND tenant = type::record('tenant', $tenant_id) LIMIT 1`,
      { name: params.project, tenant_id: ctx.tenantId }
    );
    if (!project?.id) {
      return toolError('NOT_FOUND', `Project '${params.project}' not found`);
    }
    projectId = extractRecordId(project.id, 'project');
    projectName = params.project;
  } else {
    const sessionProject = await getSessionProject(db, ctx.currentSession);
    if (!sessionProject) {
      return toolError('INVALID_INPUT', 'Project required. Specify project param or start session with a project.');
    }
    projectId = sessionProject.project_id;
    projectName = sessionProject.project_name;
  }

  const authorId = ctx.claims.sub;
  const authorExists = await db.queryOne<{ id: string }>(
    `SELECT id FROM author WHERE id = type::record('author', $author_id) LIMIT 1`,
    { author_id: authorId }
  );
  if (!authorExists) {
    await db.queryOne(
      `CREATE type::record('author', $author_id) SET name = $author_id, tenant = type::record('tenant', $tenant_id)`,
      { author_id: authorId, tenant_id: ctx.tenantId }
    );
  }

  let containerId: string;
  if (params.container) {
    const cid = extractRecordId(params.container, 'container');
    const containerExists = await db.queryOne<{ id: string }>(
      `SELECT id FROM container WHERE id = type::record('container', $container_id) LIMIT 1`,
      { container_id: cid }
    );
    if (!containerExists) {
      return toolError('NOT_FOUND', `Container not found or not accessible: ${params.container}`);
    }
    containerId = cid;
  } else {
    try {
      containerId = await ensureDefaultContainer(db, ctx.tenantId);
    } catch (err) {
      if (err instanceof DefaultContainerDeletedError) {
        return toolError('NOT_FOUND', 'The default container was deleted and is awaiting purge; nothing was saved.');
      }
      throw err;
    }
  }

  const sessionId = extractRecordId(ctx.currentSession, 'session');

  const optionalSets: string[] = [];
  const queryParams: Record<string, unknown> = {
    type: params.type,
    content: params.content,
    embedding,
    embedding_model: embed.model,
    tenant_id: ctx.tenantId,
    author_id: authorId,
    container_id: containerId,
    project_id: projectId,
    session_id: sessionId,
  };

  if (params.status) { optionalSets.push('status = $status'); queryParams.status = params.status; }
  if (params.tags?.length) { optionalSets.push('tags = $tags'); queryParams.tags = params.tags; }

  const optionalClause = optionalSets.length ? optionalSets.join(', ') + ',' : '';

  const query = `
    LET $node = (CREATE node SET
      type = $type, content = $content, source = 'mcp', embedding = $embedding,
      embedding_model = $embedding_model, ${optionalClause}
      tenant = type::record('tenant', $tenant_id),
      author = type::record('author', $author_id),
      container = type::record('container', $container_id),
      project = type::record('project', $project_id),
      session_created = type::record('session', $session_id),
      session_activated = type::record('session', $session_id),
      decay_score = 1.0
    RETURN id);
    CREATE decay_event SET
      node = $node[0].id,
      event_type = 'created',
      old_score = 0.0,
      new_score = 1.0,
      session_id = type::record('session', $session_id),
      reason = 'node_created';
    RETURN $node[0];
  `;

  const results = await db.query<CreatedNode>(query, queryParams);
  const created = results.find(r => r?.id?.toString().startsWith('node:'));

  if (!created?.id) {
    logger.error({ params: { ...queryParams, embedding: queryParams.embedding ? '[vector]' : null }, result: results }, 'Node creation failed');
    return toolError('INTERNAL', 'Failed to create node');
  }

  const nodeId = extractRecordId(created.id, 'node');

  let edgesCreated = 0;

  if (uniqueTargets.length > 0) {
    for (const targetId of uniqueTargets) {
      const target = extractRecordId(targetId, 'node');
      try {
        const targetExists = await db.queryOne<{ id: string }>(
          "SELECT id FROM type::record('node', $to_id) WHERE tenant = type::record('tenant', $tenant_id)",
          { to_id: target, tenant_id: ctx.tenantId }
        );
        if (!targetExists) {
          logger.warn({ targetId }, 'Skipping edge: node not found or belongs to different tenant');
          continue;
        }
        await db.query(
          `LET $from_node = type::record('node', $from_id);
           LET $to_node = type::record('node', $to_id);
           RELATE $from_node->edge->$to_node SET
             type = 'explicit',
             weight = 1.0,
             session_reinforced = type::record('session', $session_id)`,
          {
            from_id: nodeId,
            to_id: target,
            session_id: sessionId,
          }
        );
        edgesCreated++;
      } catch (e) {
        logger.warn({ err: e, targetId }, 'Failed to create edge');
      }
    }
  }

  return toolSuccess({
    action: 'created',
    id: created.id,
    type: params.type,
    content: params.content,
    status: params.status,
    project: projectName,
    author: ctx.claims.sub,
    tenant: ctx.tenantId,
    tags: params.tags,
    session: ctx.currentSession,
    edges_created: edgesCreated,
  });
}

export const nodeCreateTool: ToolHandler<NodeCreateParams> = {
  name: 'kg_node_create',
  description: 'Create a knowledge node (observation, decision, problem, approach, ...). Requires an active session. New nodes start fully active. Generates an embedding for semantic search and can link to existing nodes via relates_to.',
  inputSchema: nodeCreateParamsSchema,
  responseSchema: nodeCreateResponseSchema,
  requiredScope: 'kg:write',
  annotations: {
    title: 'Create Node',
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },

  async execute(
    db: KgDbClient,
    embed: EmbeddingProvider,
    ctx: ToolContext,
    params: NodeCreateParams
  ): Promise<ToolResult> {
    return createNode(db, embed, ctx, params);
  },
};
