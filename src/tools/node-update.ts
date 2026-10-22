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

/** The first field present decides why the node is reactivated. */
const ACTIVATION_REASONS = [
  ['content', 'content_update'],
  ['status', 'status_update'],
  ['tags', 'tags_update'],
] as const;

/** Columns copied straight from the params when present. The names are fixed, never user input. */
const PLAIN_COLUMNS = ['status', 'content', 'tags'] as const;

function activationReason(params: NodeUpdateParams): string {
  return ACTIVATION_REASONS.find(([field]) => params[field])?.[1] ?? 'update';
}

/** Column -> new value for what this call changes. */
function collectChanges(
  params: NodeUpdateParams,
  embedding: number[] | null,
  embeddingModel: string
): Record<string, unknown> {
  return {
    ...Object.fromEntries(PLAIN_COLUMNS.filter((column) => params[column]).map((column) => [column, params[column]])),
    ...(embedding && { embedding, embedding_model: embeddingModel }),
  };
}

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

  // Embed first: a content change whose embedding fails is rejected, so a node never
  // carries a vector that describes its previous content. Nothing has been written yet.
  let newEmbedding: number[] | null = null;
  if (params.content) {
    try {
      const [emb] = await embed.embedDocuments([params.content]);
      newEmbedding = emb;
    } catch (e) {
      logger.warn({ err: e, nodeId }, 'Failed to generate embedding for updated content');
      return toolError('INTERNAL', 'Could not generate the embedding for the new content; nothing was changed. Please retry.');
    }
  }

  const newDecayScore = await activateNode(
    db,
    nodeId,
    ctx.currentSession,
    activationReason(params)
  );

  const changes = collectChanges(params, newEmbedding, embed.model);
  const columns = Object.keys(changes);
  if (columns.length > 0) {
    const assignments = columns.map((column) => `${column} = $${column}`).join(', ');
    await db.query(`UPDATE type::record('node', $id) SET ${assignments} RETURN AFTER`, { id: nodeId, ...changes });
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
  description: 'Update the status, content or tags of an existing knowledge node and reactivate it. Tags replace the whole tag list. Changing content overwrites the previous content and regenerates the embedding; if that fails the update is rejected and the node is unchanged. Requires an active session.',
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
