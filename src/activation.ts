import { KgDbClient, ACTIVATION, extractRecordId, buildNodeRefs, normalizeRecordId } from './contracts.js';

/**
 * Neighborhood statistics for a node
 */
export interface NeighborhoodStats {
  nodes: number;
  edges: number;
  complexity: number;
  factor: number;
}

/**
 * Calculate local graph complexity from neighborhood stats.
 * Returns value 0.0-1.0
 */
export function calculateLocalComplexity(localNodes: number, localEdges: number): number {
  const n = localNodes;
  const e = localEdges;

  if (n < 2) return 0;

  const sizeFactor = Math.min(Math.log(n) / 7.0, 1.0);
  const edgeRatio = e / n;
  const edgeFactor = Math.min(edgeRatio / 5.0, 0.5);

  return Math.min(sizeFactor + edgeFactor, 1.0);
}

/**
 * Calculate activation factor based on local complexity
 */
export function calculateActivationFactor(localNodes: number, localEdges: number): number {
  const complexity = calculateLocalComplexity(localNodes, localEdges);
  return ACTIVATION.BASE_FACTOR + (ACTIVATION.MAX_FACTOR - ACTIVATION.BASE_FACTOR) * complexity;
}

/**
 * Apply activation boost to a decay score.
 * Uses asymptotic formula: new = current + (ceiling - current) * factor
 */
export function applyActivationBoost(
  currentDecay: number,
  localNodes: number,
  localEdges: number
): number {
  const factor = calculateActivationFactor(localNodes, localEdges);
  const newScore = currentDecay + (ACTIVATION.CEILING - currentDecay) * factor;
  return Math.min(newScore, ACTIVATION.CEILING);
}

const NEIGHBORHOOD_QUERY_TIMEOUT_MS = 5000;

/**
 * Get 2-hop neighborhood statistics for a node.
 * Times out after 5s and returns defaults to prevent blocking.
 */
export async function getNeighborhoodStats(
  db: KgDbClient,
  nodeId: string
): Promise<NeighborhoodStats> {
  // Native graph traversal for TYPE RELATION edges
  // ->edge->node traverses to neighbors; combine out/in for bidirectional
  // Avoid closures (.map) - they have context issues in SurrealDB
  const query = `
    LET $node = type::record('node', $node_id);
    LET $hop1_result = (SELECT ->edge->node AS out_n, <-edge<-node AS in_n FROM $node)[0] ?? {};
    LET $hop1 = array::distinct(array::concat($hop1_result.out_n ?? [], $hop1_result.in_n ?? []));
    LET $hop2_out = array::flatten((SELECT VALUE ->edge->node FROM $hop1));
    LET $hop2_in = array::flatten((SELECT VALUE <-edge<-node FROM $hop1));
    LET $hop2 = array::distinct(array::concat($hop2_out, $hop2_in));
    LET $neighborhood = array::distinct(array::concat([$node], array::concat($hop1, $hop2)));
    LET $out_edges = array::flatten((SELECT VALUE ->edge[WHERE out IN $neighborhood] FROM $neighborhood));
    LET $in_edges = array::flatten((SELECT VALUE <-edge[WHERE in IN $neighborhood] FROM $neighborhood));
    LET $internal_edges = array::distinct(array::concat($out_edges, $in_edges));
    LET $edge_count = array::len($internal_edges);
    RETURN {
        nodes: array::len($neighborhood),
        edges: $edge_count
    };
  `;

  let nodes = 1;
  let edges = 0;

  try {
    const queryPromise = db.queryOne<{ nodes: number; edges: number }>(query, {
      node_id: nodeId,
    });

    const timeoutPromise = new Promise<null>((_, reject) =>
      setTimeout(() => reject(new Error('Neighborhood query timeout')), NEIGHBORHOOD_QUERY_TIMEOUT_MS)
    );

    const result = await Promise.race([queryPromise, timeoutPromise]);
    if (result) {
      nodes = result.nodes ?? 1;
      edges = result.edges ?? 0;
    }
  } catch {
    // On timeout or error, use defaults (sparse neighborhood assumption)
  }

  const complexity = calculateLocalComplexity(nodes, edges);
  const factor = calculateActivationFactor(nodes, edges);

  return { nodes, edges, complexity, factor };
}

/**
 * Get current decay score for a node
 */
export async function getCurrentDecayScore(db: KgDbClient, nodeId: string): Promise<number> {
  const result = await db.queryOne<{ decay_score: number }>(
    "SELECT decay_score FROM type::record('node', $node_id)",
    { node_id: nodeId }
  );
  return result?.decay_score ?? 1.0;
}

/** Factor for reactive spreading to neighbors (smaller than direct activation) */
const REACTIVE_SPREAD_FACTOR = 0.1;

/**
 * Apply activation boost to a node and log the event.
 * Also reactively spreads a smaller boost to 1-hop neighbors.
 */
export async function activateNode(
  db: KgDbClient,
  nodeId: string,
  sessionId: string,
  reason?: string
): Promise<number> {
  const [oldScore, stats] = await Promise.all([
    getCurrentDecayScore(db, nodeId),
    getNeighborhoodStats(db, nodeId),
  ]);
  const newScore = applyActivationBoost(oldScore, stats.nodes, stats.edges);

  // Sequential, not Promise.all: logDecayEvent must not run (and record an
  // audit entry) unless the UPDATE it describes actually committed.
  await db.query(
    `UPDATE type::record('node', $node_id) SET
      decay_score = $new_score,
      last_activated = time::now(),
      session_activated = type::record('session', $session_id)`,
    {
      node_id: nodeId,
      new_score: newScore,
      session_id: extractRecordId(sessionId, 'session'),
    }
  );

  await logDecayEvent(db, {
    nodeId,
    eventType: 'activation',
    oldScore,
    newScore,
    factor: stats.factor,
    complexity: stats.complexity,
    localNodes: stats.nodes,
    localEdges: stats.edges,
    sessionId,
    reason,
  });

  // Reactive spreading: boost 1-hop neighbors with a smaller factor
  await reactiveSpreadToNeighbors(db, nodeId, sessionId);

  return newScore;
}

/**
 * Reactively spread activation to 1-hop neighbors.
 * Uses a smaller factor than direct activation to avoid runaway.
 */
async function reactiveSpreadToNeighbors(
  db: KgDbClient,
  nodeId: string,
  sessionId: string
): Promise<void> {
  try {
    // Native graph traversal for TYPE RELATION edges
    // UPDATE node:x->edge->node directly updates neighbors via graph traversal
    // No WHERE IN - uses native graph index
    const params = {
      node_id: nodeId,
      ceiling: ACTIVATION.CEILING,
      factor: REACTIVE_SPREAD_FACTOR,
      session_id: extractRecordId(sessionId, 'session'),
    };

    // Update outbound neighbors
    await db.query(
      `UPDATE type::record('node', $node_id)->edge->node SET
        decay_score = math::min([
          decay_score + ($ceiling - decay_score) * $factor,
          $ceiling
        ]),
        last_activated = time::now(),
        session_activated = type::record('session', $session_id)`,
      params
    );

    // Update inbound neighbors
    await db.query(
      `UPDATE type::record('node', $node_id)<-edge<-node SET
        decay_score = math::min([
          decay_score + ($ceiling - decay_score) * $factor,
          $ceiling
        ]),
        last_activated = time::now(),
        session_activated = type::record('session', $session_id)`,
      params
    );
  } catch {
    // Non-fatal: reactive spreading is best-effort
  }
}

/**
 * Activate two nodes for a kg_relate call, running concurrently unless they
 * are the same node.
 *
 * Self-relate must stay sequential: the second call needs to read the score
 * the first call already boosted, or the node gets boosted once instead of
 * twice for a valid double-activation input. Compares normalized ids since
 * SurrealDB's bracket-escaped id form (⟨...⟩) could otherwise make two
 * encodings of the same id compare unequal.
 */
export async function activatePair(
  db: KgDbClient,
  fromId: string,
  toId: string,
  sessionId: string,
  reason?: string
): Promise<[number, number]> {
  if (normalizeRecordId(fromId) === normalizeRecordId(toId)) {
    const fromDecay = await activateNode(db, fromId, sessionId, reason);
    const toDecay = await activateNode(db, toId, sessionId, reason);
    return [fromDecay, toDecay];
  }

  return Promise.all([
    activateNode(db, fromId, sessionId, reason),
    activateNode(db, toId, sessionId, reason),
  ]);
}

/**
 * Decay event types for audit logging
 */
export type DecayEventType = 'created' | 'session_decay' | 'activation' | 'manual';

/**
 * Log a decay event for audit purposes
 */
export async function logDecayEvent(
  db: KgDbClient,
  event: {
    nodeId: string;
    eventType: DecayEventType;
    oldScore: number;
    newScore: number;
    factor?: number;
    complexity?: number;
    localNodes?: number;
    localEdges?: number;
    sessionId: string;
    reason?: string;
  }
): Promise<void> {
  // Build optional fields dynamically - SurrealDB rejects NULL for `none | T` fields
  const optionalFields: [string, string, unknown][] = [
    ['factor', 'factor', event.factor],
    ['complexity', 'complexity', event.complexity],
    ['local_nodes', 'local_nodes', event.localNodes],
    ['local_edges', 'local_edges', event.localEdges],
    ['reason', 'reason', event.reason],
  ];

  const params: Record<string, unknown> = {
    node_id: event.nodeId,
    event_type: event.eventType,
    old_score: event.oldScore,
    new_score: event.newScore,
    session_id: extractRecordId(event.sessionId, 'session'),
  };

  const optionalSets = optionalFields
    .filter(([, , value]) => value !== undefined)
    .map(([field, param, value]) => {
      params[param] = value;
      return `${field} = $${param}`;
    });

  const optionalClause = optionalSets.length ? ', ' + optionalSets.join(', ') : '';

  await db.query(
    `CREATE decay_event SET
      node = type::record('node', $node_id),
      event_type = $event_type,
      old_score = $old_score,
      new_score = $new_score,
      session_id = type::record('session', $session_id)${optionalClause}`,
    params
  );
}

/**
 * Apply session decay to nodes belonging to the session's project.
 * Called when a new session starts.
 */
export async function applySessionDecay(
  db: KgDbClient,
  sessionId: string,
  tenantId: string,
  project?: string
): Promise<number> {
  // Build query dynamically - NULL vs NONE distinction matters for SurrealDB
  // CRITICAL: Always filter by tenant to prevent cross-tenant decay
  const projectId = project ? extractRecordId(project, 'project') : null;
  const whereClause = projectId
    ? `WHERE decay_score > $vacuum_threshold AND tenant = type::record('tenant', $tenant_id) AND project = type::record('project', $project_id)`
    : `WHERE decay_score > $vacuum_threshold AND tenant = type::record('tenant', $tenant_id) AND project IS NONE`;

  const params: Record<string, unknown> = {
    decay_rate: ACTIVATION.DEFAULT_DECAY_RATE,
    vacuum_threshold: ACTIVATION.VACUUM_THRESHOLD,
    tenant_id: tenantId,
  };
  if (projectId) params.project_id = projectId;

  const result = await db.query<{ id: string; decay_score: number }>(
    `UPDATE node SET decay_score = decay_score * $decay_rate ${whereClause} RETURN BEFORE`,
    params
  );

  for (const node of result) {
    const nodeId = extractRecordId(node.id, 'node');
    const oldScore = node.decay_score ?? 1.0;
    const newScore = oldScore * ACTIVATION.DEFAULT_DECAY_RATE;

    await logDecayEvent(db, {
      nodeId,
      eventType: 'session_decay',
      oldScore,
      newScore,
      factor: ACTIVATION.DEFAULT_DECAY_RATE,
      sessionId,
      reason: 'session_start',
    });
  }

  return result.length;
}

/**
 * Apply implicit activation to a batch of nodes returned from a query.
 * Lightweight: single batch UPDATE, no neighborhood calculation.
 */
export async function implicitActivateBatch(
  db: KgDbClient,
  nodeIds: string[],
  sessionId: string,
  tenantId: string
): Promise<number> {
  if (nodeIds.length === 0) return 0;

  const { recordRefs, params: idParams } = buildNodeRefs(nodeIds);
  const params: Record<string, unknown> = {
    ...idParams,
    ceiling: ACTIVATION.CEILING,
    factor: ACTIVATION.IMPLICIT_FACTOR,
    session_id: extractRecordId(sessionId, 'session'),
    tenant_id: tenantId,
  };

  // Direct record UPDATE instead of WHERE IN scan
  // UPDATE [records] uses direct record access, not table scan
  // Tenant filter still applied for defense-in-depth
  const result = await db.query(
    `UPDATE [${recordRefs}] SET
      decay_score = math::min([
        decay_score + ($ceiling - decay_score) * $factor,
        $ceiling
      ]),
      last_activated = time::now(),
      session_activated = type::record('session', $session_id)
     WHERE tenant = type::record('tenant', $tenant_id)`,
    params
  );

  return result.length;
}

// NOTE: logNodeCreated was removed - decay_event is now created atomically
// in the same transaction as the node (see tools/node-create.ts).
// This prevents race conditions where node exists but decay_event doesn't.
