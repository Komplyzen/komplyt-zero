import {
  ToolHandler,
  NodeUpdateParams,
  nodeUpdateParamsSchema,
  nodeUpdateResponseSchema,
  KgDbClient,
  EmbeddingProvider,
  ToolContext,
  ToolResult,
  toolSuccess,
  toolError,
  extractRecordId,
  NodeDbRow,
  nodeToResponse,
} from '../contracts.js';
import { activateNode } from '../activation.js';
import { childLogger } from '../logger.js';

const logger = childLogger('node-update');

async function updateNode(
  db: KgDbClient,
  embed: EmbeddingProvider,
  ctx: ToolContext,
  params: NodeUpdateParams
): Promise<ToolResult> {
  if (!ctx.currentSession) {
    return toolError('NO_SESSION', 'No active session. Start a session first with kg_session_start.');
  }

  const nodeId = extractRecordId(params.id, 'node');

  const existing = await db.queryOne<NodeDbRow>(
    "SELECT *, project.name AS project_name, author.name AS author_name, tenant.name AS tenant_name FROM type::record('node', $id) WHERE tenant = type::record('tenant', $tenant_id)",
    { id: nodeId, tenant_id: ctx.tenantId }
  );

  if (!existing) {
    return toolError('NOT_FOUND', `Node not found: ${params.id}`);
  }

  let reason: string;
  if (params.content) {
    reason = 'content_update';
  } else if (params.status) {
    reason = 'status_update';
  } else {
    reason = 'update';
  }

  const newDecayScore = await activateNode(
    db,
    nodeId,
    ctx.currentSession,
    reason
  );

  let newEmbedding: number[] | null = null;
  if (params.content) {
    try {
      const [emb] = await embed.embedDocuments([params.content]);
      newEmbedding = emb;
    } catch (e) {
      // The update still succeeds and the node keeps its old vector and
      // embedding_model, which now describe the previous content. Automatic
      // re-embedding of such stale vectors is tracked separately.
      logger.warn({ err: e, nodeId }, 'Failed to generate embedding for updated content; keeping the previous embedding');
    }
  }

  const setClauses: string[] = [];
  if (params.status) setClauses.push('status = $status');
  if (params.content) setClauses.push('content = $content');
  if (newEmbedding) setClauses.push('embedding = $embedding', 'embedding_model = $embedding_model');

  if (setClauses.length > 0) {
    const query = `UPDATE type::record('node', $id) SET ${setClauses.join(', ')} RETURN AFTER`;
    const queryParams: Record<string, unknown> = { id: nodeId };
    if (params.status) queryParams.status = params.status;
    if (params.content) queryParams.content = params.content;
    if (newEmbedding) {
      queryParams.embedding = newEmbedding;
      queryParams.embedding_model = embed.model;
    }
    await db.query(query, queryParams);
  }

  const updated = await db.queryOne<NodeDbRow>(
    "SELECT *, project.name AS project_name, author.name AS author_name, tenant.name AS tenant_name FROM type::record('node', $id)",
    { id: nodeId }
  );

  if (!updated) {
    return toolError('INTERNAL', 'Failed to update node');
  }

  return toolSuccess({
    action: 'updated',
    id: params.id,
    new_decay_score: newDecayScore,
    node: nodeToResponse(updated),
  });
}

export const nodeUpdateTool: ToolHandler<NodeUpdateParams> = {
  name: 'kg_node_update',
  description: 'Update the status or content of an existing knowledge node and reactivate it. Changing content overwrites the previous content and regenerates the embedding. Requires an active session.',
  inputSchema: nodeUpdateParamsSchema,
  responseSchema: nodeUpdateResponseSchema,
  requiredScope: 'kg:write',
  annotations: {
    title: 'Update Node',
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },

  async execute(
    db: KgDbClient,
    embed: EmbeddingProvider,
    ctx: ToolContext,
    params: NodeUpdateParams
  ): Promise<ToolResult> {
    return updateNode(db, embed, ctx, params);
  },
};
