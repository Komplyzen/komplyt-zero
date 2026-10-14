import {
  ToolHandler,
  RelateParams,
  relateParamsSchema,
  relateResponseSchema,
  KgDbClient,
  EmbeddingProvider,
  ToolContext,
  ToolResult,
  toolSuccess,
  toolError,
  extractRecordId,
} from '../contracts.js';
import { activatePair } from '../activation.js';
import { childLogger } from '../logger.js';

const logger = childLogger('kg_relate');

const SESSION_EDGE_LIMIT = 100;
// const TENANT_HOURLY_EDGE_LIMIT = 1000; // Disabled - see TODO in execute()

interface NodeIdResult {
  id: string;
}

interface EdgeResult {
  id: string;
  weight: number;
}


export const relateTool: ToolHandler<RelateParams> = {
  name: 'kg_relate',
  description: 'Create a relationship between two knowledge nodes, or reinforce it if it already exists (the edge weight increases). Both nodes are reactivated (their decay scores are boosted). Requires an active session; limited to 100 edges per session.',
  inputSchema: relateParamsSchema,
  responseSchema: relateResponseSchema,
  requiredScope: 'kg:write',
  annotations: {
    title: 'Relate Knowledge',
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },

  async execute(
    db: KgDbClient,
    _embed: EmbeddingProvider,
    ctx: ToolContext,
    params: RelateParams
  ): Promise<ToolResult> {
    if (!ctx.currentSession) {
      return toolError('NO_SESSION', 'No active session. Start a session first with kg_session_start.');
    }

    const fromId = extractRecordId(params.from, 'node');
    const toId = extractRecordId(params.to, 'node');
    const sessionId = extractRecordId(ctx.currentSession, 'session');

    // Checked first and sequentially, not folded into the Promise.all below:
    // this is a rate limiter, and rejecting it should stay a single cheap
    // round trip instead of paying for two more node lookups on every reject.
    const sessionEdgeCount = await db.queryOne<{ count: number }>(
      `SELECT count() AS count FROM edge WHERE session_reinforced = type::record('session', $session_id) GROUP ALL`,
      { session_id: sessionId }
    );

    if ((sessionEdgeCount?.count ?? 0) >= SESSION_EDGE_LIMIT) {
      logger.warn({ sessionId, count: sessionEdgeCount?.count }, 'Session edge limit reached');
      return toolError('INVALID_INPUT', `Edge creation limit reached (${SESSION_EDGE_LIMIT} per session). Start a new session to continue.`);
    }

    // TODO: Tenant hourly limit disabled - the traversal edge -> node -> tenant is too slow
    // without proper indexing. Session limit (100/session) provides sufficient rate limiting.
    // Re-enable after adding: DEFINE INDEX edge_created_at ON edge FIELDS created_at;
    // and denormalizing tenant onto edge table.

    // CRITICAL: Filter by tenant to prevent cross-tenant node linking (IDOR)
    const [fromExists, toExists] = await Promise.all([
      db.queryOne<NodeIdResult>(
        "SELECT id FROM type::record('node', $from_id) WHERE tenant = type::record('tenant', $tenant_id)",
        { from_id: fromId, tenant_id: ctx.tenantId }
      ),
      db.queryOne<NodeIdResult>(
        "SELECT id FROM type::record('node', $to_id) WHERE tenant = type::record('tenant', $tenant_id)",
        { to_id: toId, tenant_id: ctx.tenantId }
      ),
    ]);

    if (!fromExists) {
      return toolError('NOT_FOUND', `Source node not found: ${params.from}`);
    }

    if (!toExists) {
      return toolError('NOT_FOUND', `Target node not found: ${params.to}`);
    }

    const existingEdge = await db.queryOne<EdgeResult>(
      `SELECT * FROM edge
       WHERE in = type::record('node', $from_id)
         AND out = type::record('node', $to_id)
       LIMIT 1`,
      { from_id: fromId, to_id: toId }
    );

    let action: 'created' | 'reinforced';
    let weight: number;

    if (existingEdge) {
      const rawEdgeId = String(existingEdge.id);
      const edgeId = rawEdgeId.startsWith('edge:') ? rawEdgeId.slice(5) : rawEdgeId;
      const updated = await db.queryOne<EdgeResult>(
        `UPDATE type::record('edge', $edge_id) SET
          weight = weight + 0.2,
          last_reinforced = time::now(),
          session_reinforced = type::record('session', $session_id)
        RETURN AFTER`,
        { edge_id: edgeId, session_id: sessionId }
      );
      action = 'reinforced';
      weight = updated?.weight ?? existingEdge.weight + 0.2;
    } else {
      await db.query(
        `LET $from_node = type::record('node', $from_id);
         LET $to_node = type::record('node', $to_id);
         RELATE $from_node->edge->$to_node SET
          type = 'explicit',
          weight = 1.0,
          session_reinforced = type::record('session', $session_id)`,
        { from_id: fromId, to_id: toId, session_id: sessionId }
      );
      action = 'created';
      weight = 1.0;
    }

    const reason = `relate_${action}`;
    const [fromDecay, toDecay] = await activatePair(db, fromId, toId, ctx.currentSession, reason);

    return toolSuccess({
      action,
      from: params.from,
      to: params.to,
      weight,
      from_decay_score: fromDecay,
      to_decay_score: toDecay,
    });
  },
};
