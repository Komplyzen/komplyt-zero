import { z } from 'zod';

// ============================================================
// CONTRACT VERSION
// ============================================================

/** Bump when breaking changes are made to contracts */
export const CONTRACT_VERSION = '1.0.0';

// ============================================================
// AUTH CLAIMS (from Komplyt JWT)
// ============================================================

/** Subscription tier for feature gating (matches Komplyt tenant_tier enum) */
export type SubscriptionTier = 'free' | 'team' | 'pro' | 'enterprise';

/** Platform-level role from Komplyt `users.role` (cross-tenant, not tenant membership) */
export type PlatformRole = 'admin' | 'member';

export interface KgTokenPayload {
  sub: string;
  tenantId: string;
  projects: string[];
  scope: string;
  /** Principal IDs for container grant RLS (e.g., ['principal:user_abc', 'principal:tenant_xyz']) */
  principals: string[];
  /** Subscription tier from Komplyt auth (defaults to 'free' if not present) */
  tier: SubscriptionTier;
  /** Komplyzen staff role for /admin routes — absent means 'member'; only 'admin' unlocks anything */
  platformRole?: PlatformRole;
}

// ============================================================
// PRINCIPAL TYPES (ADR-014)
// ============================================================

export const PrincipalType = z.enum(['User', 'Tenant', 'Project']);
export type PrincipalType = z.infer<typeof PrincipalType>;

/**
 * Build principal record ID from type and ref_id.
 * Format: principal:{type}_{refId} — matches SurrealDB record ID format
 * so CONTAINSANY comparison works correctly.
 */
export function principalId(type: PrincipalType, refId: string): string {
  // SurrealDB record IDs in JWT are strings like "principal:user_abc"
  // The CONTAINSANY operator compares these string representations
  return `principal:${type.toLowerCase()}_${refId}`;
}

/** Parse principal ID to [type, refId] */
export function parsePrincipalId(id: string): [PrincipalType, string] | null {
  const match = id.match(/^principal:(user|tenant|project)_(.+)$/);
  if (!match) return null;
  const type = match[1].charAt(0).toUpperCase() + match[1].slice(1) as PrincipalType;
  return [type, match[2]];
}

/** Check if scope includes required scope */
export function hasScope(tokenScope: string, required: ToolScope): boolean {
  return tokenScope.split(' ').includes(required);
}

/**
 * Strip SurrealDB's ⟨...⟩ id-escaping (applied when an id segment contains
 * special characters like `:`). Record IDs in this codebase are sometimes
 * name-based and colon-containing (e.g. project ids), so this escaping shows
 * up on any string-serialized id for such a record - it must be stripped
 * before the id is used as a bound param in a fresh type::record() call,
 * or SurrealDB re-escapes the leftover brackets into a corrupted nested form.
 *
 * Strips one level of escaping per call - sufficient to prevent NEW
 * corruption (a correctly single-escaped id in, a clean id out), but does
 * not iteratively unwrap an already multiply-corrupted historical value.
 * Repairing already-corrupted data is a data migration's job (the hosted
 * graph had one), not this function's.
 */
function stripBracketEscaping(str: string): string {
  return str.replace(/⟨([^⟩]+)⟩/g, '$1');
}

/**
 * Extract the ID portion from a SurrealDB record reference.
 * Handles both string format ("table:id") and SDK RecordId objects.
 * Strips SurrealDB's ⟨...⟩ escaping from the id portion in both cases, so the
 * result is always safe to re-bind into type::record() without double-escaping.
 */
export function extractRecordId(
  recordRef: string | { tb: string; id: string },
  expectedTable: string
): string {
  // Handle plain RecordId object { tb, id } BEFORE stringifying
  // (String() on objects returns "[object Object]")
  if (typeof recordRef === 'object' && recordRef !== null && 'tb' in recordRef) {
    if (recordRef.tb !== expectedTable) {
      throw new Error(`Expected ${expectedTable} record, got ${recordRef.tb}`);
    }
    return stripBracketEscaping(String(recordRef.id));
  }

  // Coerce to string - handles SurrealDB StringRecordId class (has toString())
  const refStr = String(recordRef);
  const prefix = `${expectedTable}:`;

  if (refStr.startsWith(prefix)) {
    return stripBracketEscaping(refStr.slice(prefix.length));
  }
  if (refStr.includes(':')) {
    const [table, id] = refStr.split(':', 2);
    if (table !== expectedTable) {
      throw new Error(`Expected ${expectedTable} record, got ${table}: ${refStr}`);
    }
    return stripBracketEscaping(id);
  }

  return stripBracketEscaping(refStr);
}

/**
 * Normalize a record ID to consistent string format (no angle bracket escaping).
 */
export function normalizeRecordId(ref: unknown): string {
  return stripBracketEscaping(String(ref));
}

/**
 * Build type::record() references + bound params for an IN-clause over node IDs.
 * SDK doesn't auto-convert {tb,id} objects for IN clauses, so each id needs its
 * own bound param and an explicit type::record('node', $idN) reference.
 */
export function buildNodeRefs(nodeIds: string[]): { recordRefs: string; params: Record<string, string> } {
  const cleanIds = nodeIds.map(id => extractRecordId(id, 'node'));
  const recordRefs = cleanIds.map((_, i) => `type::record('node', $id${i})`).join(', ');
  const params: Record<string, string> = {};
  cleanIds.forEach((id, i) => { params[`id${i}`] = id; });
  return { recordRefs, params };
}

// ============================================================
// DATABASE
// ============================================================

/**
 * Database client interface.
 *
 * Lifecycle: Caller MUST call close() when done. Connection is NOT pooled.
 * SurrealDB queries return arrays-of-arrays (one per statement).
 */
export interface KgDbClient {
  /**
   * Execute a SurrealQL query.
   * Returns flattened results from all statements.
   * For multi-statement queries, results are concatenated.
   */
  query<T>(sql: string, vars?: Record<string, unknown>): Promise<T[]>;

  /**
   * Execute a single-statement query and return first result or null.
   */
  queryOne<T>(sql: string, vars?: Record<string, unknown>): Promise<T | null>;

  /**
   * Release the connection back to pool. Preferred over close() for pooled clients.
   * For non-pooled clients, this falls back to close().
   */
  release?(): Promise<void>;

  /**
   * Close the connection. For pooled clients, this releases to pool.
   * For non-pooled clients (e.g., createRootConnection wrappers), this closes the connection.
   */
  close(): Promise<void>;
}

export interface DbFactory {
  // A scoped connection is backed by a kg_auth_session row that is pruned after
  // KG_SESSION_RETENTION_HOURS. Sign in per request (as the HTTP transport and
  // the stdio CLI do); never hold one across that window. Direct connections
  // throw ScopedSessionExpiredError once they are too old to trust.
  /**
   * Create a scoped connection for the given claims.
   * The connection injects tenantId/projects for RLS.
   * Caller owns the connection and MUST call close().
   *
   * @param signal Optional AbortSignal - if aborted, the session will be cleaned up
   */
  createScoped(claims: KgTokenPayload, signal?: AbortSignal): Promise<KgDbClient>;
}

export interface SessionRecord {
  id: string;
  session_num: number;
  project?: string;
  project_name?: string;
  tenant?: string;
  tenant_name?: string;
  notes?: string;
  started_at?: string;
  ended_at?: string;
}

// ============================================================
// EMBEDDING
// ============================================================

/**
 * Vector length every stored embedding must have (the HNSW index DIMENSION).
 * One provider per install; its model must output exactly this many dimensions.
 */
export const EMBEDDING_DIMENSIONS = 1024 as const;

export interface EmbeddingProvider {
  /** Model identifier recorded in node.embedding_model (e.g. 'cohere-embed-multilingual-v3.0') */
  readonly model: string;

  /** Embed documents for storage (inputType: search_document) */
  embedDocuments(texts: string[]): Promise<number[][]>;

  /** Embed query for similarity search (inputType: search_query) */
  embedQuery(text: string): Promise<number[]>;

  /** Dimension of embeddings — should match stored vectors */
  readonly dimensions: number;
}

// ============================================================
// ENUMS (matching Rust db/queries.rs)
// ============================================================

export const NodeType = z.enum([
  'observation',
  'decision',
  'argument',
  'todo',
  'problem',
  'mitigation',
  'workaround',
  'approach',
]);
export type NodeType = z.infer<typeof NodeType>;

export const Status = z.enum(['open', 'resolved', 'blocked', 'done']);
export type Status = z.infer<typeof Status>;

export const MetaModelScope = z.enum(['container', 'project', 'person']);
export type MetaModelScope = z.infer<typeof MetaModelScope>;

export const MetaModelLens = z.enum(['methodology', 'resiliency', 'process']);
export type MetaModelLens = z.infer<typeof MetaModelLens>;

/**
 * Plans that include the stored meta-models on the hosted service. The batch job computes only for
 * these (its LICENSED_TIERS / METHODOLOGY_TIERS defaults), and the tool refuses everyone else, so the
 * two lists must agree: the job's reader-contract test compares its defaults with these.
 * `pro` is a personal plan: it gets the resiliency and process lenses but not methodology.
 */
export const META_MODEL_LICENSED_TIERS = ['team', 'pro', 'enterprise'] as const;
export const META_MODEL_METHODOLOGY_TIERS = ['team', 'enterprise'] as const;

export const MetaModelStatus = z.enum(['confident', 'provisional', 'insufficient', 'not_computed', 'error']);
export type MetaModelStatus = z.infer<typeof MetaModelStatus>;

// ============================================================
// TOOL RESULT + ERROR HANDLING
// ============================================================

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  /** Error code for HTTP status mapping. Set when isError=true. */
  errorCode?: 'INVALID_INPUT' | 'NOT_FOUND' | 'SCOPE_DENIED' | 'NO_SESSION' | 'INTERNAL' | 'RATE_LIMITED';
}

/** Standard error codes for programmatic handling */
export enum ErrorCode {
  VALIDATION = 'E001',
  AUTH = 'E002',
  RATE_LIMIT = 'E003',
  NOT_FOUND = 'E004',
  DB_ERROR = 'E005',
  EMBED_ERROR = 'E006',
  NO_SESSION = 'E007',
  INTERNAL = 'E999',
}

export interface ToolError {
  code: ErrorCode;
  message: string;
}

/** Create a success result */
export function toolSuccess<T>(data: T): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
  };
}

/**
 * Error code to HTTP status mapping. Literal statuses so the REST router can
 * pass them to c.json() unchanged; each one must be a declared error response
 * in openapi.ts (errorResponses).
 */
export const ERROR_HTTP_STATUS = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  SCOPE_DENIED: 403,
  NO_SESSION: 400,
  INTERNAL: 500,
  RATE_LIMITED: 429,
} as const satisfies Record<NonNullable<ToolResult['errorCode']>, 400 | 403 | 404 | 429 | 500>;

/** Create an error result */
export function toolError(
  errorCode: ToolResult['errorCode'],
  message: string
): ToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
    errorCode,
  };
}

// ============================================================
// TOOL HANDLER
// ============================================================

export type ToolScope = 'kg:read' | 'kg:write';

/** Tool names as a union type for exhaustive checking */
export type ToolName = 'kg_node_create' | 'kg_node_update' | 'kg_query' | 'kg_relate' | 'kg_session_start' | 'kg_session_end' | 'kg_session_info' | 'kg_meta_model' | 'kg_status';

/**
 * MCP tool annotations for client behavior hints (OpenAI marketplace requirement).
 * See: https://modelcontextprotocol.io/specification/2025-06-18/server/tools#annotations
 *
 * Justifications for OpenAI submission review:
 * - readOnlyHint: false = tool creates/modifies nodes in the knowledge graph
 * - readOnlyHint: true = tool only reads data, no mutations
 * - openWorldHint: false = tool operates only on user's tenant-scoped graph, no external systems
 * - destructiveHint: false = changes are additive or reversible, no permanent deletion
 * - destructiveHint: true = tool can overwrite/modify existing data
 * - idempotentHint: true = repeated calls with same args have no additional effect
 * - idempotentHint: false = each call may create new records or change state
 */
export interface ToolAnnotations {
  /** Human-readable title for UI display */
  title: string;
  /** If true, tool does not modify server state (safe to call without confirmation) */
  readOnlyHint: boolean;
  /** If true, tool may interact with external/untrusted entities */
  openWorldHint: boolean;
  /** If true, tool may perform destructive operations (delete, overwrite) */
  destructiveHint: boolean;
  /** If true, repeated calls with same arguments have no additional effect */
  idempotentHint: boolean;
}

export interface ToolHandler<TParams = unknown, TResponse = unknown> {
  name: ToolName;
  description: string;
  inputSchema: z.ZodType<TParams>;
  responseSchema: z.ZodType<TResponse>;
  requiredScope: ToolScope;
  annotations: ToolAnnotations;

  /**
   * Execute the tool.
   * @param db Scoped database client (caller manages lifecycle)
   * @param embed Embedding provider
   * @param ctx Execution context (claims, session, etc.)
   * @param params Validated input parameters
   */
  execute(
    db: KgDbClient,
    embed: EmbeddingProvider,
    ctx: ToolContext,
    params: TParams
  ): Promise<ToolResult>;
}

/**
 * Context passed to every tool execution.
 * Flattens commonly-accessed JWT claims for convenience while keeping
 * the full claims object available for advanced use cases.
 */
export interface ToolContext {
  /** Full JWT payload */
  claims: KgTokenPayload;

  /** Tenant ID from JWT tenantId claim */
  tenantId: string;
  /** Projects the user has access to (from JWT projects claim) */
  projects: string[];
  /** Space-separated scopes (e.g., "kg:read kg:write") */
  scope: string;

  /** Current session ID (RecordId as string). Required for most tools. */
  currentSession: string | null;
}

export interface ToolRegistry {
  list(): ToolHandler[];
  get(name: ToolName): ToolHandler | undefined;
}

// ============================================================
// TOOL SCOPES (exhaustive)
// ============================================================

export const TOOL_SCOPES: Record<ToolName, ToolScope> = {
  kg_node_create: 'kg:write',
  kg_node_update: 'kg:write',
  kg_query: 'kg:read',
  kg_relate: 'kg:write',
  kg_session_start: 'kg:write',
  kg_session_end: 'kg:write',
  kg_session_info: 'kg:read',
  kg_meta_model: 'kg:read',
  kg_status: 'kg:read',
} as const;

// ============================================================
// TOOL PARAMETER SCHEMAS (matching Rust exactly)
// ============================================================

// Coercible types for MCP clients that serialize params as strings
const coercibleBool = z.union([z.boolean(), z.string().transform(s => s === 'true')]);
const coercibleInt = z.union([z.number(), z.string().transform(s => parseInt(s, 10))]);
const coercibleFloat = z.union([z.number(), z.string().transform(s => parseFloat(s))]);
const coercibleStringArray = z.union([
  z.array(z.string()),
  z.string().transform(s => {
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : [s];
    } catch {
      return [s];
    }
  }),
]);

// --- kg_node_create / kg_node_update ---
// One tool per operation (OpenAI review rule L17: no action-dispatch tools).
// Note: author and tenant are derived from JWT, not agent-settable
export const nodeCreateParamsSchema = z.object({
  type: NodeType,
  content: z.string().min(1).refine(s => s.trim().length > 0, 'Content cannot be whitespace-only'),
  status: Status.optional(),
  relates_to: coercibleStringArray.optional().describe('Node IDs to relate to (max 20)'),
  project: z.string().optional(),
  container: z.string().optional().describe('Container ID. If omitted, uses tenant default container.'),
  tags: coercibleStringArray.optional(),
});
export type NodeCreateParams = z.infer<typeof nodeCreateParamsSchema>;

export const nodeUpdateParamsSchema = z.object({
  id: z.string().min(1).describe('Node ID (e.g., "node:abc123")'),
  status: Status.optional(),
  content: z.string().optional().describe('Updated content. Regenerates embedding.'),
});
export type NodeUpdateParams = z.infer<typeof nodeUpdateParamsSchema>;

// --- kg_query (from query.rs:85-104) ---
export const queryParamsSchema = z.object({
  text: z.string().optional().describe('Semantic search query'),
  type: NodeType.optional(),
  status: Status.optional(),
  project: z.string().optional(),
  author: z.string().optional(),
  tenant: z.string().optional(),
  include_related: coercibleBool.default(false).describe('Include directly related nodes'),
  spread: coercibleBool.default(true).describe('Enable spreading activation'),
  spread_hops: coercibleInt.pipe(z.number().int().min(1).max(3)).default(2).describe('Hops for spreading (clamped 1-3)'),
  spread_factor: coercibleFloat.pipe(z.number().min(0).max(1)).default(0.5).describe('Decay factor per hop'),
  activation_threshold: coercibleFloat.pipe(z.number().min(0).max(1)).default(0.1).describe('Min activation to include'),
  limit: coercibleInt.pipe(z.number().int().min(1).max(100)).default(10),
  include_edges: coercibleBool.default(true).describe('Include edges between result nodes'),
  include_neighbors: coercibleBool.default(true).describe('Include neighbor references per node'),
  neighbors_limit: coercibleInt.pipe(z.number().int().min(1).max(50)).default(10).describe('Max neighbors per node'),
  read_only: coercibleBool.default(false).describe('Skip implicit activation of returned nodes. The query then performs no writes: no decay_score change, no last_activated or session_activated update. For read-only consumers (dashboards, benchmarks) where observing must not reinforce. Send a JSON boolean or the literal string "true"; any other string coerces to false and the query will write.'),
});
export type QueryParams = z.infer<typeof queryParamsSchema>;

// --- kg_relate (from relate.rs:35-39) ---
export const relateParamsSchema = z.object({
  from: z.string().describe('Source node ID'),
  to: z.string().describe('Target node ID'),
});
export type RelateParams = z.infer<typeof relateParamsSchema>;

// --- kg_session_start / kg_session_end / kg_session_info ---
// One tool per operation (OpenAI review rule L17: no action-dispatch tools).
export const sessionStartParamsSchema = z.object({
  project: z.string().optional().describe('Project to scope the session to'),
  create_project: coercibleBool.default(false).describe('Create the project if it does not exist'),
  notes: z.string().optional().describe('Session notes'),
});
export type SessionStartParams = z.infer<typeof sessionStartParamsSchema>;

export const sessionEndParamsSchema = z.object({});
export type SessionEndParams = z.infer<typeof sessionEndParamsSchema>;

export const sessionInfoParamsSchema = z.object({});
export type SessionInfoParams = z.infer<typeof sessionInfoParamsSchema>;

// --- kg_status ---
export const statusParamsSchema = z.object({
  project: z.string().optional(),
});
export type StatusParams = z.infer<typeof statusParamsSchema>;

// --- kg_meta_model (methodology extraction) ---
export const metaModelParamsSchema = z.object({
  scope: MetaModelScope.describe('Scope: container, project, or person'),
  id: z.string().optional().describe('Identifier for scope. Project: name. Person: email. Container: omit for current, or explicit ID.'),
  lens: MetaModelLens.default('methodology').describe('Lens: methodology (default), resiliency, or process'),
}).refine(
  (data) => {
    if ((data.scope === 'project' || data.scope === 'person') && !data.id) return false;
    return true;
  },
  { message: 'id is required for scope=project or scope=person' }
);
export type MetaModelParams = z.infer<typeof metaModelParamsSchema>;

// ============================================================
// RESPONSE SCHEMAS (matching Rust responses)
// ============================================================

// --- NodeDbRow: raw row from database queries (SELECT *, project.name AS project_name ...) ---
export interface NodeDbRow {
  id: string;
  type: string;
  content: string;
  source?: string;
  status?: string;
  project?: string;
  project_name?: string;
  tags?: string[];
  author?: string;
  author_name?: string;
  tenant?: string;
  tenant_name?: string;
  created_at?: string;
  last_activated?: string;
  session_created?: string;
  session_activated?: string;
  decay_score?: number;
  semantic_score?: number;
  combined_score?: number;
}

// --- NodeResponse (from queries.rs:296-322) ---
export const nodeResponseSchema = z.object({
  id: z.string(),
  type: NodeType,
  content: z.string(),
  source: z.string().optional(),
  status: Status.optional(),
  project: z.string().optional(),
  tags: z.array(z.string()).optional(),
  author: z.string().optional(),
  tenant: z.string().optional(),
  created_at: z.string().optional(),
  last_activated: z.string().optional(),
  session_created: z.string().optional(),
  session_activated: z.string().optional(),
  decay_score: z.number().optional(),
  semantic_score: z.number().optional(),
  combined_score: z.number().optional(),
  neighbors: z.array(z.object({
    id: z.string(),
    direction: z.enum(['out', 'in']),
    weight: z.number(),
    type: z.string(),
  })).optional(),
});
export type NodeResponse = z.infer<typeof nodeResponseSchema>;

/** Convert a database row to API response (uses human-readable names, not record IDs) */
export function nodeToResponse(node: NodeDbRow): NodeResponse {
  return {
    id: node.id,
    type: node.type as NodeResponse['type'],
    content: node.content,
    source: node.source,
    status: node.status as NodeResponse['status'],
    project: node.project_name,
    tags: node.tags,
    author: node.author_name,
    tenant: node.tenant_name,
    created_at: node.created_at,
    last_activated: node.last_activated,
    session_created: node.session_created,
    session_activated: node.session_activated,
    decay_score: node.decay_score,
    semantic_score: node.semantic_score,
    combined_score: node.combined_score,
  };
}

// --- ActivatedNodeResponse (from query.rs:107-115) ---
export const activatedNodeResponseSchema = nodeResponseSchema.extend({
  activation: z.number(),
  activation_source: z.enum(['direct', 'spread']),
  activation_path: z.array(z.string()).optional(),
});
export type ActivatedNodeResponse = z.infer<typeof activatedNodeResponseSchema>;

// --- Neighbor reference (CAP-3) ---
export const neighborSchema = z.object({
  id: z.string(),
  direction: z.enum(['out', 'in']),
  weight: z.number(),
  type: z.string(),
});
export type Neighbor = z.infer<typeof neighborSchema>;

// --- Edge between result nodes (CAP-1) ---
export const edgeResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  direction: z.literal('out'),
  weight: z.number(),
  type: z.string(),
});
export type EdgeResponse = z.infer<typeof edgeResponseSchema>;

// --- kg_node_create / kg_node_update responses ---
export const nodeCreateResponseSchema = z.object({
  action: z.literal('created'),
  id: z.string(),
  type: NodeType,
  content: z.string(),
  status: Status.optional(),
  project: z.string().optional(),
  author: z.string().optional(),
  tenant: z.string().optional(),
  tags: z.array(z.string()).optional(),
  session: z.string(),
  edges_created: z.number(),
});
export type NodeCreateResponse = z.infer<typeof nodeCreateResponseSchema>;

export const nodeUpdateResponseSchema = z.object({
  action: z.literal('updated'),
  id: z.string(),
  new_decay_score: z.number(),
  node: nodeResponseSchema,
});
export type NodeUpdateResponse = z.infer<typeof nodeUpdateResponseSchema>;

// --- QueryResponse ---
export const queryResponseSchema = z.object({
  nodes: z.array(nodeResponseSchema),
  count: z.number(),
  mode: z.enum(['filter', 'semantic', 'spreading_activation']).optional(),
  hops: z.number().optional(),
  edges: z.array(edgeResponseSchema).optional(),
  timeout: z.boolean().optional(),
  truncated: z.boolean().optional(),
  hint: z.string().optional(),
});
export type QueryResponse = z.infer<typeof queryResponseSchema>;

// --- RelateResponse ---
export const relateResponseSchema = z.object({
  action: z.enum(['created', 'reinforced']),
  from: z.string(),
  to: z.string(),
  weight: z.number(),
  from_decay_score: z.number(),
  to_decay_score: z.number(),
});
export type RelateResponse = z.infer<typeof relateResponseSchema>;

// --- SessionStartResponse ---
export const sessionStartResponseSchema = z.object({
  action: z.literal('started'),
  session_id: z.string(),
  session_number: z.number(),
  project: z.string().optional(),
  tenant: z.string().optional(),
  notes: z.string().optional(),
  nodes_decayed: z.number(),
});
export type SessionStartResponse = z.infer<typeof sessionStartResponseSchema>;

// --- SessionInfoResponse ---
export const sessionInfoResponseSchema = z.object({
  session_number: z.number(),
  current_session: z.object({
    session_id: z.string().optional(),
    session_number: z.number().optional(),
    started_at: z.string().optional(),
    ended_at: z.string().optional(),
    project: z.string().optional(),
    tenant: z.string().optional(),
    notes: z.string().optional(),
  }).optional(),
  node_counts: z.record(z.string(), z.number()),
});
export type SessionInfoResponse = z.infer<typeof sessionInfoResponseSchema>;

// --- SessionEndResponse ---
export const sessionEndResponseSchema = z.object({
  action: z.literal('ended'),
  session_id: z.string(),
  session_number: z.number(),
  started_at: z.string(),
  ended_at: z.string(),
  project: z.string().optional(),
  tenant: z.string().optional(),
});
export type SessionEndResponse = z.infer<typeof sessionEndResponseSchema>;

// --- StatusResponse ---
export const statusResponseSchema = z.object({
  current_session: z.number(),
  /**
   * True whenever current_session is nonzero. resolveActiveSession
   * only ever returns active sessions, so this can never be false for a
   * present session - it's an explicit, forward-compatible signal (a caller
   * doesn't need to know kg_status's internal filtering to trust "current
   * session shown here is active") rather than a live active-vs-ended
   * distinction, which this endpoint structurally cannot show anymore.
   */
  session_active: z.boolean().optional(),
  session_started: z.string().optional(),
  session_project: z.string().optional(),
  total_nodes: z.number(),
  open_todos: z.array(nodeResponseSchema),
  open_problems: z.array(nodeResponseSchema),
  recent_decisions: z.array(nodeResponseSchema),
  recent_approaches: z.array(nodeResponseSchema),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;

// --- MetaModelResponse (kg_meta_model) ---
export const metaModelErrorCodes = z.enum([
  'container_not_found',
  'access_denied',
  'invalid_scope',
  'internal_error',
  'tier_required',
]);
export type MetaModelErrorCode = z.infer<typeof metaModelErrorCodes>;

// Methodology lens meta_model shape
// Computed ahead of time by a batch job and stored in the meta_model table; this is the shape
// of the stored `model` for the methodology lens.

export const decisionHeuristicSchema = z.object({
  trigger: z.string().describe('What triggers this heuristic'),
  action: z.string().describe('What action follows'),
  evidence: z.object({
    sessions: z.number().describe('Number of sessions where this pattern appears'),
    examples: z.array(z.string()).describe('Node IDs for drill-down'),
  }),
});
export type DecisionHeuristic = z.infer<typeof decisionHeuristicSchema>;

export const qualityGateSchema = z.object({
  name: z.string().describe('Gate name (e.g., adversarial_review)'),
  position: z.enum(['early', 'mid', 'late']).describe('Typical position in session'),
  frequency: z.number().min(0).max(1).describe('Portion of sessions where this appears'),
  typical_outcomes: z.array(z.string()).describe('Outcome types where this gate is common'),
});
export type QualityGate = z.infer<typeof qualityGateSchema>;

export const recoveryPatternSchema = z.object({
  problem_type: z.string().describe('Category of problem'),
  resolution: z.string().describe('How it gets resolved'),
  not_done: z.string().describe('Explicit anti-pattern to avoid'),
});
export type RecoveryPattern = z.infer<typeof recoveryPatternSchema>;

export const structuralInvariantSchema = z.object({
  context: z.string().describe('Where this invariant applies'),
  invariant: z.string().describe('What relationship holds'),
  violation_rate: z.number().min(0).max(1).describe('How often it is violated'),
});
export type StructuralInvariant = z.infer<typeof structuralInvariantSchema>;

export const organizingConceptSchema = z.object({
  content: z.string().describe('The organizing concept content'),
  hierarchy_level: z.enum(['root', 'organizing', 'intermediate'])
    .describe('Position in knowledge hierarchy (root = most fundamental)'),
  connected_topics: z.array(z.string())
    .describe('Topics that branch off from this concept'),
});
export type OrganizingConcept = z.infer<typeof organizingConceptSchema>;

export const methodologyMetaModelSchema = z.object({
  organizing_concepts: z.array(organizingConceptSchema)
    .describe('Core concepts that structure the knowledge (derived from Poincaré hierarchy)'),
  decision_heuristics: z.array(decisionHeuristicSchema)
    .describe('Trigger → action patterns that repeat across sessions'),
  quality_gates: z.array(qualityGateSchema)
    .describe('Checkpoints appearing in significant portion of sessions'),
  recovery_patterns: z.array(recoveryPatternSchema)
    .describe('How problem types get resolved'),
  documentation_rules: z.array(z.string())
    .describe('Patterns in how knowledge is recorded'),
  structural_invariants: z.array(structuralInvariantSchema)
    .describe('Ordering/relationships that hold across sessions'),
  sessions_analyzed: z.number(),
  nodes_analyzed: z.number(),
});
export type MethodologyMetaModel = z.infer<typeof methodologyMetaModelSchema>;

// Resiliency lens meta_model shape
export const resiliencyMetaModelSchema = z.object({
  person_dependency: z.array(z.object({
    person: z.string(),
    concentration: z.number(),
    domains: z.array(z.string()),
  })),
  knowledge_concentration: z.record(z.string(), z.object({
    contributors: z.number(),
    risk: z.enum(['high', 'medium', 'low']),
  })),
  bus_factor_by_domain: z.record(z.string(), z.number()),
  handoff_coverage_experimental: z.number(),
  orphan_risk: z.array(z.string()),
  orphan_contributor_ratio: z.number(),
});
export type ResiliencyMetaModel = z.infer<typeof resiliencyMetaModelSchema>;

// Process lens meta_model shape (content-based, no cluster IDs exposed)
export const processTransitionSchema = z.object({
  from_content: z.string(),
  to_content: z.string(),
  count: z.number(),
});
export type ProcessTransition = z.infer<typeof processTransitionSchema>;

export const sessionArcSchema = z.object({
  session_id: z.string(),
  steps: z.array(z.object({
    content: z.string(),
    type: z.string(),
    step: z.number(),
  })),
  outcome: z.string(),
});
export type SessionArc = z.infer<typeof sessionArcSchema>;

export const processRecipeSchema = z.object({
  outcome: z.string(),
  sessions: z.number(),
  avg_steps: z.number(),
  top_transitions: z.array(processTransitionSchema),
  example_arcs: z.array(sessionArcSchema),
  final_outputs: z.array(z.string()),
});
export type ProcessRecipe = z.infer<typeof processRecipeSchema>;

export const processMetaModelSchema = z.object({
  recipes: z.array(processRecipeSchema),
  global_transitions: z.array(processTransitionSchema),
  sessions_analyzed: z.number(),
  edges_analyzed: z.number(),
});
export type ProcessMetaModel = z.infer<typeof processMetaModelSchema>;

// Success response (confident or provisional)
export const metaModelSuccessResponseSchema = z.object({
  status: z.enum(['confident', 'provisional']),
  explanation: z.string(),
  meta_model: methodologyMetaModelSchema.or(resiliencyMetaModelSchema).or(processMetaModelSchema),
  /** When the stored model was computed (ISO 8601). */
  computed_at: z.string().optional(),
});
export type MetaModelSuccessResponse = z.infer<typeof metaModelSuccessResponseSchema>;

// Insufficient data response
export const metaModelInsufficientResponseSchema = z.object({
  status: z.literal('insufficient'),
  explanation: z.string(),
  meta_model: z.null(),
  /** When the stored result was computed (ISO 8601). */
  computed_at: z.string().optional(),
});
export type MetaModelInsufficientResponse = z.infer<typeof metaModelInsufficientResponseSchema>;

// Nothing stored for this scope and lens yet (the batch job has not run for it). Not an error.
export const metaModelNotComputedResponseSchema = z.object({
  status: z.literal('not_computed'),
  explanation: z.string(),
  meta_model: z.null(),
});
export type MetaModelNotComputedResponse = z.infer<typeof metaModelNotComputedResponseSchema>;

// Error response
export const metaModelErrorResponseSchema = z.object({
  status: z.literal('error'),
  explanation: z.string(),
  error_code: metaModelErrorCodes,
});
export type MetaModelErrorResponse = z.infer<typeof metaModelErrorResponseSchema>;

// Combined response
export const metaModelResponseSchema = metaModelSuccessResponseSchema
  .or(metaModelInsufficientResponseSchema)
  .or(metaModelNotComputedResponseSchema)
  .or(metaModelErrorResponseSchema);
export type MetaModelResponse = z.infer<typeof metaModelResponseSchema>;

// ============================================================
// ACTIVATION CONSTANTS (from queries.rs:377-391)
// ============================================================

// ============================================================
// CONTAINER API SCHEMAS
// ============================================================

// Container name: 1-63 chars, ^[a-z0-9][a-z0-9-_]*( [a-z0-9-_]+)*$
const containerNameRegex = /^[a-z0-9][a-z0-9_-]*( [a-z0-9_-]+)*$/;

// Principal format: principal:(user|group|tenant|project)_{id}
const principalFormatRegex = /^principal:(user|group|tenant|project)_[a-zA-Z0-9-]+$/;

// --- Container Create ---
export const containerCreateSchema = z.object({
  name: z.string()
    .min(1, 'Name is required')
    .max(63, 'Name must be 63 characters or less')
    .regex(containerNameRegex, 'Name must start with alphanumeric and contain only lowercase alphanumerics, hyphens, underscores, and single spaces'),
  owner: z.string().regex(principalFormatRegex, 'Invalid principal format').optional(),
});
export type ContainerCreateParams = z.infer<typeof containerCreateSchema>;

// --- Container List Query ---
export const containerListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  cursor: z.string().optional(),
  include_deleted: z.coerce.boolean().default(false),
});
export type ContainerListQuery = z.infer<typeof containerListQuerySchema>;

// --- Grant/Revoke Principal ---
export const containerGrantSchema = z.object({
  principal: z.string().regex(principalFormatRegex, 'Invalid principal format'),
});
export type ContainerGrantParams = z.infer<typeof containerGrantSchema>;

// --- Container Response (full details) ---
export const containerResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner: z.string(),
  tenant: z.string(),
  granted_principals: z.array(z.string()),
  created_at: z.string(),
  deleted_at: z.string().nullable().optional(),
  first_deleted_at: z.string().nullable().optional(),
});
export type ContainerResponse = z.infer<typeof containerResponseSchema>;

// --- Container List Item (subset for list endpoint) ---
export const containerListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner: z.string(),
  granted_principals: z.array(z.string()),
  created_at: z.string(),
  deleted_at: z.string().nullable().optional(),
});
export type ContainerListItem = z.infer<typeof containerListItemSchema>;

// --- Container List Response ---
export const containerListResponseSchema = z.object({
  containers: z.array(containerListItemSchema),
  next_cursor: z.string().nullable(),
});
export type ContainerListResponse = z.infer<typeof containerListResponseSchema>;

// --- Grant Response ---
export const containerGrantResponseSchema = z.object({
  granted: z.boolean(),
  principal: z.string(),
  container: z.string(),
});
export type ContainerGrantResponse = z.infer<typeof containerGrantResponseSchema>;

// --- Revoke Response ---
export const containerRevokeResponseSchema = z.object({
  revoked: z.boolean(),
  principal: z.string(),
  container: z.string(),
});
export type ContainerRevokeResponse = z.infer<typeof containerRevokeResponseSchema>;

// --- Delete Response ---
export const containerDeleteResponseSchema = z.object({
  deleted: z.boolean(),
  container: z.string(),
  deleted_at: z.string(),
  purge_after: z.string(),
});
export type ContainerDeleteResponse = z.infer<typeof containerDeleteResponseSchema>;

// --- Restore Response ---
export const containerRestoreResponseSchema = z.object({
  restored: z.boolean(),
  container: z.string(),
  purge_after: z.string(),
});
export type ContainerRestoreResponse = z.infer<typeof containerRestoreResponseSchema>;

// --- Admin Soft-Delete ---
// Reason is the documentation of the processor assist-obligation (GDPR Art. 28(3)(e)):
// non-empty after trimming, minimum 10 characters — long enough to force a real
// justification ("GDPR request #1234"), short enough to not demand an essay.
export const adminSoftDeleteSchema = z.object({
  reason: z.string()
    .trim()
    .min(10, 'Reason must be at least 10 characters after trimming')
    .max(500, 'Reason must be at most 500 characters'),
});
export type AdminSoftDeleteBody = z.infer<typeof adminSoftDeleteSchema>;

export const adminSoftDeleteResponseSchema = z.object({
  deleted: z.boolean(),
  container: z.string(),
  tenant: z.string(),
  deleted_at: z.string(),
  purge_after: z.string(),
  audit_id: z.string(),
});
export type AdminSoftDeleteResponse = z.infer<typeof adminSoftDeleteResponseSchema>;

// --- Purge Job (CAP-1) ---
export const AUDIT_ACTION = {
  CONTAINER_PURGE: 'container_purge',
  ADMIN_SOFT_DELETE: 'admin_soft_delete',
} as const;
export type AuditAction = typeof AUDIT_ACTION[keyof typeof AUDIT_ACTION];

/** Days a container stays restorable after first soft-delete before hard purge */
export const PURGE_RETENTION_DAYS = 30;

/** Single source for the purge deadline shown by delete/restore/admin responses */
export function purgeAfter(
  firstDeletedAt: string | Date,
  retentionDays: number = PURGE_RETENTION_DAYS
): string {
  return new Date(
    new Date(firstDeletedAt).getTime() + retentionDays * 24 * 60 * 60 * 1000
  ).toISOString();
}

// --- Container Error Codes ---
export const ContainerErrorCode = {
  INVALID_INPUT: 'INVALID_INPUT',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UNPROCESSABLE: 'UNPROCESSABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;
export type ContainerErrorCode = typeof ContainerErrorCode[keyof typeof ContainerErrorCode];

export const CONTAINER_ERROR_HTTP_STATUS: Record<ContainerErrorCode, number> = {
  INVALID_INPUT: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
};

// ============================================================
// ACTIVATION CONSTANTS (from queries.rs:377-391)
// ============================================================

export const ACTIVATION = {
  /** Ceiling for activation boost — can't fake current-session freshness */
  CEILING: 0.85,
  /** Base activation factor for sparse neighborhoods */
  BASE_FACTOR: 0.15,
  /** Max activation factor for dense neighborhoods */
  MAX_FACTOR: 0.40,
  /** Decay floor — nodes stop decaying below this (28 more sessions vs 0.01) */
  VACUUM_THRESHOLD: 0.0001,
  /** Implicit activation for query results */
  IMPLICIT_FACTOR: 0.05,
  /** Default decay rate per session */
  DEFAULT_DECAY_RATE: 0.85,
  /** Edge decay rate (slower than nodes) */
  DEFAULT_EDGE_DECAY_RATE: 0.95,
  /** Min edge weight before pruning */
  MIN_EDGE_WEIGHT: 0.05,
} as const;
