import { z } from 'zod';
import {
  ToolHandler,
  QueryParams,
  queryParamsSchema,
  queryResponseSchema,
  KgDbClient,
  EmbeddingProvider,
  ToolContext,
  ToolResult,
  toolSuccess,
  toolError,
  ActivatedNodeResponse,
  Neighbor,
  EdgeResponse,
  normalizeRecordId,
  buildNodeRefs,
  NodeDbRow,
  nodeToResponse,
} from '../contracts.js';
import { implicitActivateBatch } from '../activation.js';
import { childLogger } from '../logger.js';

const logger = childLogger('kg_query');

// CAP-1: Extended from 5s to 15s to allow 2-hop spread queries to complete
const QUERY_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 50 * 1024;

// CAP-5: Structured timeout logging helper
function logQueryTimeout(
  phase: string,
  ctx: ToolContext,
  params: QueryParams,
  nodeCount: number,
  startTime: number
): void {
  logger.warn({
    event: 'query_timeout',
    phase,
    elapsed_ms: Date.now() - startTime,
    tenant_id: ctx.tenantId,
    session_id: ctx.currentSession,
    params: {
      text: params.text?.slice(0, 100),
      type: params.type,
      status: params.status,
      project: params.project,
      spread: params.spread,
      spread_hops: params.spread_hops,
      spread_factor: params.spread_factor,
      limit: params.limit,
      include_edges: params.include_edges,
      include_neighbors: params.include_neighbors,
      neighbors_limit: params.neighbors_limit,
    },
    nodes_at_timeout: nodeCount,
  }, 'Query timeout');
}

// Fan-out bounds for spreading activation. PR #83 batched the
// per-hop neighbor query into one round trip but left both the input
// (active-node-id set) and output (edge count) of that query unbounded -
// a graph with enough fan-out could pass hundreds of ids into one query and
// pull back a correspondingly huge edge set, OOMing the Cloud Run container.
// spread_hops is already clamped to 1-3 (contracts.ts), so bounding each
// hop's query cost to these constants bounds cumulative cost across a
// max-depth spread to at most 3x a single hop's cost - not just per-hop.
// SurrealDB Cloud struggles with large IN clauses (50 nodes → 23s+).
// 15 nodes keeps hop queries under 3s while still providing good spread coverage.
const MAX_ACTIVE_NODES_PER_HOP = 15;
const MAX_EDGES_PER_BATCH_QUERY = 500;

export function checkTimeout(startTime: number): boolean {
  return Date.now() - startTime >= QUERY_TIMEOUT_MS;
}

export { QUERY_TIMEOUT_MS, MAX_RESPONSE_BYTES };

export function truncateNeighbors(
  nodes: Array<{ neighbors?: Array<unknown> } & Record<string, unknown>>,
  maxBytes: number
): { nodes: typeof nodes; truncated: boolean } {
  let current = JSON.stringify({ nodes, count: nodes.length }).length;
  if (current <= maxBytes) {
    return { nodes, truncated: false };
  }

  const result = nodes.map(node => {
    if (!node.neighbors || node.neighbors.length === 0) return node;
    const reduced = { ...node, neighbors: node.neighbors.slice(0, 5) };
    return reduced;
  });

  current = JSON.stringify({ nodes: result, count: result.length }).length;
  if (current <= maxBytes) {
    return { nodes: result, truncated: true };
  }

  const minimal = result.map(node => ({ ...node, neighbors: undefined }));
  return { nodes: minimal, truncated: true };
}

type Node = NodeDbRow;

interface EdgeNeighbor {
  neighbor: string;
  effective_weight: number;
}



async function verifyProject(
  db: KgDbClient,
  projectName: string | undefined,
  tenantId: string
): Promise<string | null> {
  if (!projectName) return null;

  const existing = await db.queryOne<{ id: string }>(
    "SELECT id FROM project WHERE name = $name AND tenant = type::record('tenant', $tenant_id)",
    { name: projectName, tenant_id: tenantId }
  );

  if (!existing) {
    const available = await db.query<{ name: string }>(
      "SELECT name FROM project WHERE tenant = type::record('tenant', $tenant_id)",
      { tenant_id: tenantId }
    );
    const names = available.map(p => p.name).join(', ') || '(none)';
    return `Project '${projectName}' not found. Available: ${names}`;
  }
  return null;
}

async function semanticSearch(
  db: KgDbClient,
  queryEmbedding: number[],
  params: QueryParams,
  tenantId: string
): Promise<Node[]> {
  // CRITICAL: Always filter by tenant - mandatory, not optional
  const conditions: string[] = [
    'embedding IS NOT NONE',
    "tenant = type::record('tenant', $tenant_id)",
  ];

  if (params.type) conditions.push('type = $type');
  if (params.status) conditions.push('status = $status');
  if (params.project) conditions.push('project.name = $project');
  if (params.author) conditions.push("author = type::record('author', $author)");

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const query = `
    SELECT
      *,
      project.name AS project_name,
      author.name AS author_name,
      tenant.name AS tenant_name,
      vector::similarity::cosine(embedding, $query_embedding) AS semantic_score,
      (decay_score * 0.3 + vector::similarity::cosine(embedding, $query_embedding) * 0.7) AS combined_score
    FROM node
    ${whereClause}
    ORDER BY combined_score DESC
    LIMIT $limit
  `;

  const queryParams: Record<string, unknown> = {
    query_embedding: queryEmbedding,
    limit: params.limit,
    tenant_id: tenantId,
  };
  if (params.type) queryParams.type = params.type;
  if (params.status) queryParams.status = params.status;
  if (params.project) queryParams.project = params.project;
  if (params.author) queryParams.author = params.author;

  return db.query<Node>(query, queryParams);
}

async function filterSearch(
  db: KgDbClient,
  params: QueryParams,
  tenantId: string
): Promise<Node[]> {
  // CRITICAL: Always filter by tenant - mandatory, not optional
  const conditions: string[] = ["tenant = type::record('tenant', $tenant_id)"];

  if (params.type) conditions.push('type = $type');
  if (params.status) conditions.push('status = $status');
  if (params.project) conditions.push('project.name = $project');
  if (params.author) conditions.push("author = type::record('author', $author)");

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const query = `
    SELECT *, project.name AS project_name, author.name AS author_name, tenant.name AS tenant_name
    FROM node
    ${whereClause}
    ORDER BY decay_score DESC
    LIMIT $limit
  `;

  const queryParams: Record<string, unknown> = { limit: params.limit, tenant_id: tenantId };
  if (params.type) queryParams.type = params.type;
  if (params.status) queryParams.status = params.status;
  if (params.project) queryParams.project = params.project;
  if (params.author) queryParams.author = params.author;

  return db.query<Node>(query, queryParams);
}

async function fetchRelated(db: KgDbClient, nodeIds: string[]): Promise<Node[]> {
  if (nodeIds.length === 0) return [];

  const { recordRefs, params } = buildNodeRefs(nodeIds);

  // Native graph traversal for TYPE RELATION edges
  // Subquery on traversal result to get full nodes with FK name resolution in one round-trip
  const results = await db.query<{ out_nodes: Node[]; in_nodes: Node[] }>(
    `SELECT
       (SELECT *, project.name AS project_name, author.name AS author_name, tenant.name AS tenant_name FROM ->edge->node) AS out_nodes,
       (SELECT *, project.name AS project_name, author.name AS author_name, tenant.name AS tenant_name FROM <-edge<-node) AS in_nodes
     FROM [${recordRefs}]`,
    params
  );

  const seen = new Set<string>(nodeIds);
  const related: Node[] = [];

  for (const r of results) {
    for (const node of [...(r.out_nodes ?? []), ...(r.in_nodes ?? [])]) {
      if (node?.id && !seen.has(String(node.id))) {
        seen.add(String(node.id));
        related.push(node);
      }
    }
  }

  return related;
}

// Exported for direct integration testing - the tool's own
// response `limit` maxes out at 100, below the edge-count bound this
// function enforces, so that bound can't be observed through kg_query's
// output and needs to be asserted directly. Matches this codebase's
// existing precedent (e.g. activation.ts's applyActivationBoost) of
// exporting pure/isolable internals for direct verification.
export async function getNeighborsWithWeightsBatch(
  db: KgDbClient,
  nodeIds: string[]
): Promise<Map<string, EdgeNeighbor[]>> {
  const bySource = new Map<string, EdgeNeighbor[]>();
  if (nodeIds.length === 0) return bySource;

  const { recordRefs, params } = buildNodeRefs(nodeIds);

  // Native graph traversal for TYPE RELATION edges
  // Subquery wrapping enables ORDER BY + LIMIT on native traversal results
  // Run outbound and inbound separately to track direction correctly
  const edgeLimitPerDirection = Math.ceil(MAX_EDGES_PER_BATCH_QUERY / 2);

  const outResults = await db.query<{ in: string; out: string; weight: number }>(
    `SELECT * FROM (SELECT in, out, weight FROM [${recordRefs}]->edge WHERE weight > 0.05)
     ORDER BY weight DESC LIMIT $limit`,
    { ...params, limit: edgeLimitPerDirection }
  );

  const inResults = await db.query<{ in: string; out: string; weight: number }>(
    `SELECT * FROM (SELECT in, out, weight FROM [${recordRefs}]<-edge WHERE weight > 0.05)
     ORDER BY weight DESC LIMIT $limit`,
    { ...params, limit: edgeLimitPerDirection }
  );

  // Dedup per source: track which (source, neighbor) pairs we've seen
  const seen = new Map<string, Set<string>>();

  // Process outbound edges: source=in, neighbor=out
  // Results are already flat (not nested in .edges) due to subquery
  for (const e of outResults) {
    if (!e.in || !e.out) continue;
    const sourceId = normalizeRecordId(String(e.in));
    const neighborId = normalizeRecordId(String(e.out));

    const seenForSource = seen.get(sourceId) ?? new Set();
    if (seenForSource.has(neighborId)) continue;
    seenForSource.add(neighborId);
    seen.set(sourceId, seenForSource);

    const list = bySource.get(sourceId) ?? [];
    list.push({ neighbor: neighborId, effective_weight: e.weight });
    bySource.set(sourceId, list);
  }

  // Process inbound edges: source=out, neighbor=in
  for (const e of inResults) {
    if (!e.in || !e.out) continue;
    const sourceId = normalizeRecordId(String(e.out));
    const neighborId = normalizeRecordId(String(e.in));

    const seenForSource = seen.get(sourceId) ?? new Set();
    if (seenForSource.has(neighborId)) continue;
    seenForSource.add(neighborId);
    seen.set(sourceId, seenForSource);

    const list = bySource.get(sourceId) ?? [];
    list.push({ neighbor: neighborId, effective_weight: e.weight });
    bySource.set(sourceId, list);
  }

  return bySource;
}

async function fetchNodesByIds(db: KgDbClient, ids: string[]): Promise<Node[]> {
  if (ids.length === 0) return [];

  const { recordRefs, params } = buildNodeRefs(ids);

  // Direct record access instead of WHERE IN scan.
  // SurrealDB v3: `SELECT *, <alias> FROM [record refs]` silently drops the
  // `*` expansion and returns only the aliased fields (empty-looking rows),
  // so materialize the records in a subquery first and project on top of it.
  return db.query<Node>(
    `SELECT *, project.name AS project_name, author.name AS author_name, tenant.name AS tenant_name FROM (SELECT * FROM [${recordRefs}])`,
    params
  );
}

async function fetchNeighborsForNodes(
  db: KgDbClient,
  nodeIds: string[],
  limitPerNode: number
): Promise<Map<string, Neighbor[]>> {
  if (nodeIds.length === 0) return new Map();

  const { recordRefs, params } = buildNodeRefs(nodeIds);

  // Native graph traversal for TYPE RELATION edges
  // Subquery wrapping enables ORDER BY + LIMIT; cap total edges to prevent memory issues
  // Per-source limiting is done client-side since SurrealDB doesn't support LIMIT per GROUP
  const totalLimit = nodeIds.length * limitPerNode * 2; // generous cap

  const outResults = await db.query<{ in: string; out: string; weight: number; type: string }>(
    `SELECT * FROM (SELECT in, out, weight, type FROM [${recordRefs}]->edge WHERE weight > 0.001)
     ORDER BY weight DESC LIMIT $limit`,
    { ...params, limit: totalLimit }
  );

  const inResults = await db.query<{ in: string; out: string; weight: number; type: string }>(
    `SELECT * FROM (SELECT in, out, weight, type FROM [${recordRefs}]<-edge WHERE weight > 0.001)
     ORDER BY weight DESC LIMIT $limit`,
    { ...params, limit: totalLimit }
  );

  // Combine with direction tagging - results are flat from subquery
  const allEdges: Array<{ in: string; out: string; weight: number; type: string; direction: 'out' | 'in' }> = [
    ...outResults.map(e => ({ ...e, direction: 'out' as const })),
    ...inResults.map(e => ({ ...e, direction: 'in' as const })),
  ];

  allEdges.sort((a, b) => b.weight - a.weight);

  const result = new Map<string, Neighbor[]>();
  const seen = new Map<string, Set<string>>();

  for (const e of allEdges) {
    // For outbound: source=in, neighbor=out; for inbound: source=out, neighbor=in
    const sourceId = normalizeRecordId(String(e.direction === 'out' ? e.in : e.out));
    const neighborId = normalizeRecordId(String(e.direction === 'out' ? e.out : e.in));

    const seenForSource = seen.get(sourceId) ?? new Set();
    if (seenForSource.has(neighborId)) continue;
    seenForSource.add(neighborId);
    seen.set(sourceId, seenForSource);

    const neighbors = result.get(sourceId) ?? [];
    if (neighbors.length < limitPerNode) {
      neighbors.push({
        id: neighborId,
        direction: e.direction,
        weight: e.weight,
        type: e.type,
      });
      result.set(sourceId, neighbors);
    }
  }

  return result;
}

async function fetchEdgesBetweenNodes(
  db: KgDbClient,
  nodeIds: string[]
): Promise<EdgeResponse[]> {
  if (nodeIds.length < 2) return [];

  const { recordRefs, params } = buildNodeRefs(nodeIds);

  // Native graph traversal for TYPE RELATION edges
  // Subquery with filter to edges where both endpoints are in the node set
  const results = await db.query<{ in: string; out: string; weight: number; type: string }>(
    `SELECT * FROM (SELECT in, out, weight, type FROM [${recordRefs}]->edge WHERE out IN [${recordRefs}] AND weight > 0.001)
     ORDER BY weight DESC LIMIT $limit`,
    { ...params, limit: MAX_EDGES_PER_BATCH_QUERY }
  );

  return results.map(e => ({
    from: normalizeRecordId(String(e.in)),
    to: normalizeRecordId(String(e.out)),
    direction: 'out' as const,
    weight: e.weight,
    type: e.type,
  }));
}

/**
 * Selects which active nodes to query for a hop's neighbors.
 * Exported for direct unit testing - the cap value and the
 * already-expanded exclusion are both easy to get subtly wrong (off-by-one,
 * or re-including nodes that add no new information) and neither is
 * observable through kg_query's own output (final response `limit` maxes
 * at 100, well below where these effects would show up).
 *
 * hop 0 (seeds only, already bounded by params.limit) returns every
 * qualifying candidate unfiltered and uncapped - see spreadingActivation's
 * hop-0 comment for why.
 *
 * From hop 1 on: candidates are (a) never-expanded nodes, or (b)
 * already-expanded nodes whose score has since improved (a later hop found
 * a stronger path to them, so re-querying their neighbors can propagate a
 * higher score downstream) - excludes already-expanded, unchanged nodes
 * (typically the seeds) from silently consuming the entire cap every hop
 * and crowding out newly-discovered nodes, which would collapse multi-hop
 * spreading into "just re-expand the seeds repeatedly." Sorted by score
 * descending, then by a strict id tie-break (not locale-sensitive
 * comparison) for deterministic truncation at the cap boundary, then
 * capped to maxActiveNodesPerHop.
 */
export function selectActiveNodesForHop(
  activation: Map<string, number>,
  activationThreshold: number,
  expandedAtScore: Map<string, number>,
  hop: number,
  maxActiveNodesPerHop: number
): string[] {
  const candidates = Array.from(activation.entries()).filter(([id, score]) => {
    if (score < activationThreshold) return false;
    if (hop === 0) return true;
    const lastExpandedScore = expandedAtScore.get(id);
    return lastExpandedScore === undefined || score > lastExpandedScore;
  });

  if (hop === 0) {
    return candidates.map(([id]) => id);
  }

  return candidates
    .sort(([idA, scoreA], [idB, scoreB]) => scoreB - scoreA || (idA < idB ? -1 : idA > idB ? 1 : 0))
    .slice(0, maxActiveNodesPerHop)
    .map(([id]) => id);
}

async function spreadingActivation(
  db: KgDbClient,
  seeds: Node[],
  hops: number,
  spreadFactor: number,
  activationThreshold: number,
  limit: number
): Promise<ActivatedNodeResponse[]> {
  const activation = new Map<string, number>();
  const activationPaths = new Map<string, string[]>();
  const seedIds = new Set<string>();
  const expandedAtScore = new Map<string, number>();

  for (const node of seeds) {
    if (node.id) {
      // Normalize ID format for consistent map lookups
      const normalizedId = normalizeRecordId(String(node.id));
      const initial = node.combined_score ?? node.decay_score ?? 1.0;
      activation.set(normalizedId, initial);
      activationPaths.set(normalizedId, [normalizedId]);
      seedIds.add(normalizedId);
    }
  }

  for (let hop = 0; hop < hops; hop++) {
    const updates = new Map<string, { score: number; path: string[] }>();

    // Cap the active-node set BEFORE querying - see
    // selectActiveNodesForHop's docstring for why hop 0 is exempt and why
    // already-expanded-unchanged nodes are excluded from hop 1+.
    const activeNodeIds = selectActiveNodesForHop(activation, activationThreshold, expandedAtScore, hop, MAX_ACTIVE_NODES_PER_HOP);

    const neighborsBySource = await getNeighborsWithWeightsBatch(db, activeNodeIds);

    for (const nodeId of activeNodeIds) {
      const score = activation.get(nodeId) ?? 0;
      expandedAtScore.set(nodeId, score);
      const edges = neighborsBySource.get(nodeId) ?? [];
      const currentPath = activationPaths.get(nodeId) ?? [nodeId];

      for (const { neighbor, effective_weight } of edges) {
        // Normalize neighbor ID for consistent lookups
        const normalizedNeighbor = normalizeRecordId(String(neighbor));
        if (currentPath.includes(normalizedNeighbor)) continue;

        const neighborActivation = score * effective_weight * spreadFactor;
        if (neighborActivation >= activationThreshold) {
          const current = updates.get(normalizedNeighbor);
          if (!current || neighborActivation > current.score) {
            updates.set(normalizedNeighbor, {
              score: neighborActivation,
              path: [...currentPath, normalizedNeighbor],
            });
          }
        }
      }
    }

    for (const [id, { score, path }] of updates) {
      const current = activation.get(id) ?? 0;
      if (score > current) {
        activation.set(id, score);
        if (!activationPaths.has(id)) {
          activationPaths.set(id, path);
        }
      }
    }
  }

  const activatedIds = Array.from(activation.entries())
    .filter(([, score]) => score >= activationThreshold)
    .map(([id]) => id);

  if (activatedIds.length === 0) return [];

  const nodes = await fetchNodesByIds(db, activatedIds);

  const results: ActivatedNodeResponse[] = nodes
    .filter(node => node.id)
    .map(node => {
      // Normalize fetched node ID for map lookups
      const normalizedId = normalizeRecordId(String(node.id));
      const isSeed = seedIds.has(normalizedId);
      const path = activationPaths.get(normalizedId);
      return {
        ...nodeToResponse(node),
        activation: activation.get(normalizedId) ?? 0,
        activation_source: isSeed ? 'direct' as const : 'spread' as const,
        activation_path: isSeed ? undefined : path,
      };
    });

  results.sort((a, b) => b.activation - a.activation);
  return results.slice(0, limit);
}

export const queryTool: ToolHandler<QueryParams> = {
  name: 'kg_query',
  description: 'Search knowledge by semantic similarity, type, status, or recency. Returns nodes ranked by relevance. Use spread=true to find related nodes via spreading activation. With an active session, returned nodes are reactivated (their usage-based decay score is boosted; node content is not changed); pass read_only=true to search without changing anything.',
  inputSchema: queryParamsSchema as z.ZodType<QueryParams>,
  responseSchema: queryResponseSchema,
  requiredScope: 'kg:read',
  annotations: {
    title: 'Query Knowledge',
    // Not read-only: with an active session, returned nodes are implicitly
    // activated (usage metrics decay_score / last_activated change) unless
    // read_only=true. Not destructive: node content is never modified.
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },

  async execute(
    db: KgDbClient,
    embed: EmbeddingProvider,
    ctx: ToolContext,
    params: QueryParams
  ): Promise<ToolResult> {
    const startTime = Date.now();
    let timedOut = false;

    const projectError = await verifyProject(db, params.project, ctx.tenantId);
    logger.info({ elapsed: Date.now() - startTime, phase: 'verify_project' }, 'Query phase timing');
    if (projectError) {
      return toolError('NOT_FOUND', projectError);
    }

    let embedTime = 0;
    let searchTime = 0;
    let nodes: Node[];
    if (params.text) {
      const embedStart = Date.now();
      const queryEmbedding = await embed.embedQuery(params.text);
      embedTime = Date.now() - embedStart;
      const searchStart = Date.now();
      nodes = await semanticSearch(db, queryEmbedding, params, ctx.tenantId);
      searchTime = Date.now() - searchStart;
    } else {
      const searchStart = Date.now();
      nodes = await filterSearch(db, params, ctx.tenantId);
      searchTime = Date.now() - searchStart;
    }
    logger.info({ elapsed: Date.now() - startTime, embedTime, searchTime, nodeCount: nodes.length, phase: 'search' }, 'Query phase timing');

    if (checkTimeout(startTime)) {
      timedOut = true;
      logQueryTimeout('search', ctx, params, nodes.length, startTime);
      const response = {
        nodes: nodes.map(nodeToResponse),
        count: nodes.length,
        timeout: true,
        hint: 'Query timed out. To reduce cost: set spread=false, or reduce limit.',
      };
      return toolSuccess(response);
    }

    if (params.spread && nodes.length > 0) {
      const spreadHops = Math.min(Math.max(params.spread_hops ?? 2, 1), 3);
      const spreadFactor = params.spread_factor ?? 0.5;
      const activationThreshold = params.activation_threshold ?? 0.1;

      const activated = await spreadingActivation(
        db,
        nodes,
        spreadHops,
        spreadFactor,
        activationThreshold,
        params.limit ?? 10
      );

      if (checkTimeout(startTime)) {
        logQueryTimeout('spreading_activation', ctx, params, activated.length, startTime);
        const response = {
          nodes: activated,
          count: activated.length,
          mode: 'spreading_activation' as const,
          hops: spreadHops,
          timeout: true,
          hint: 'Query timed out. To reduce cost: set spread_hops=1, or include_edges=false, or include_neighbors=false, or reduce limit.',
        };
        return toolSuccess(response);
      }

      const nodeIds = activated.map(n => n.id);
      const includeEdges = params.include_edges ?? true;
      const includeNeighbors = params.include_neighbors ?? true;
      const neighborsLimit = params.neighbors_limit ?? 10;

      // CAP-3: Parallel topology fetches - run edges and neighbors concurrently
      const [edges, neighborsMap] = await Promise.all([
        includeEdges && nodeIds.length >= 2 && !checkTimeout(startTime)
          ? fetchEdgesBetweenNodes(db, nodeIds)
          : Promise.resolve(undefined),
        includeNeighbors && !checkTimeout(startTime)
          ? fetchNeighborsForNodes(db, nodeIds, neighborsLimit)
          : Promise.resolve(new Map<string, Neighbor[]>()),
      ]);

      const activatedWithNeighbors = includeNeighbors
        ? activated.map(node => ({
            ...node,
            neighbors: neighborsMap.get(node.id),
          }))
        : activated;

      timedOut = checkTimeout(startTime);
      if (timedOut) {
        logQueryTimeout('topology', ctx, params, activatedWithNeighbors.length, startTime);
      }
      const baseResponse = {
        nodes: activatedWithNeighbors,
        count: activatedWithNeighbors.length,
        mode: 'spreading_activation' as const,
        hops: spreadHops,
        edges,
        timeout: timedOut || undefined,
        hint: timedOut ? 'Query timed out. To reduce cost: set include_edges=false, or include_neighbors=false.' : undefined,
      };

      const { nodes: finalNodes, truncated } = truncateNeighbors(
        baseResponse.nodes as Array<{ neighbors?: Array<unknown> } & Record<string, unknown>>,
        MAX_RESPONSE_BYTES
      );

      if (truncated) {
        logger.info({ nodeCount: finalNodes.length, phase: 'truncation' }, 'Response truncated to fit size limit');
      }

      return toolSuccess({
        ...baseResponse,
        nodes: finalNodes,
        truncated: truncated || undefined,
      });
    }

    let responseNodes = nodes.map(nodeToResponse);

    if (params.include_related && responseNodes.length > 0 && !checkTimeout(startTime)) {
      const nodeIds = responseNodes.map(n => n.id);
      const related = await fetchRelated(db, nodeIds);

      const existingIds = new Set(nodeIds);
      for (const node of related) {
        if (!existingIds.has(node.id)) {
          responseNodes.push(nodeToResponse(node));
          existingIds.add(node.id);
        }
      }
    }

    const nodeIds = responseNodes.map(n => n.id);
    const includeEdges = params.include_edges ?? true;
    const includeNeighbors = params.include_neighbors ?? true;
    const neighborsLimit = params.neighbors_limit ?? 10;

    // CAP-3: Parallel topology fetches - run edges and neighbors concurrently
    const [edges, neighborsMap] = await Promise.all([
      includeEdges && nodeIds.length >= 2 && !checkTimeout(startTime)
        ? fetchEdgesBetweenNodes(db, nodeIds)
        : Promise.resolve(undefined),
      includeNeighbors && nodeIds.length > 0 && !checkTimeout(startTime)
        ? fetchNeighborsForNodes(db, nodeIds, neighborsLimit)
        : Promise.resolve(new Map<string, Neighbor[]>()),
    ]);

    if (includeNeighbors && neighborsMap.size > 0) {
      responseNodes = responseNodes.map(node => ({
        ...node,
        neighbors: neighborsMap.get(node.id),
      }));
    }

    // Implicit activation is the query path's only write. read_only
    // gates it here rather than inside implicitActivateBatch so the activation
    // helper stays a pure "do the write" primitive and the decision to observe
    // without reinforcing is visible at the call site. The spreading_activation
    // branch above returns before this point and has never activated
    // implicitly, so read_only changes nothing there.
    if (ctx.currentSession && responseNodes.length > 0 && !params.read_only) {
      await implicitActivateBatch(db, nodeIds, ctx.currentSession, ctx.tenantId);
    }

    timedOut = checkTimeout(startTime);
    if (timedOut) {
      logQueryTimeout('topology', ctx, params, responseNodes.length, startTime);
    }
    const baseResponse = {
      nodes: responseNodes,
      count: responseNodes.length,
      edges,
      timeout: timedOut || undefined,
      hint: timedOut ? 'Query timed out. To reduce cost: set include_edges=false, or include_neighbors=false.' : undefined,
    };

    const { nodes: finalNodes, truncated } = truncateNeighbors(
      baseResponse.nodes as Array<{ neighbors?: Array<unknown> } & Record<string, unknown>>,
      MAX_RESPONSE_BYTES
    );

    if (truncated) {
      logger.info({ nodeCount: finalNodes.length, phase: 'truncation' }, 'Response truncated to fit size limit');
    }

    logger.debug({ elapsed: Date.now() - startTime, nodeCount: finalNodes.length, edgeCount: edges?.length ?? 0, timedOut, truncated }, 'Query completed');

    return toolSuccess({
      ...baseResponse,
      nodes: finalNodes,
      truncated: truncated || undefined,
    });
  },
};
