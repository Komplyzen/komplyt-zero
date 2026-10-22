import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { AuthError, validateToken, requireScope, wwwAuthenticateHeader } from './auth.js';
import { getLocalModeClaims } from './auth-local.js';
import type { KgTokenPayload, KgDbClient, ToolContext, ToolRegistry, EmbeddingProvider, ToolName, DbFactory } from './contracts.js';
import { resolveActiveSession } from './tools/session-core.js';
import { getLegacyTool } from './tools/legacy.js';
import { env } from './env.js';
import { createRequire } from 'module';
import type { z } from 'zod';
import { childLogger } from './logger.js';

const require = createRequire(import.meta.url);
const packageJson = require('./package.json');

const logger = childLogger('mcp');

const SUPPORTED_VERSIONS = ['2025-06-18', '2024-11-05'] as const;
const NEWEST_VERSION = SUPPORTED_VERSIONS[0];

const MCP_INSTRUCTIONS = 'Persistent knowledge graph memory. Query before recording to avoid duplicates; activate (kg_node_update) nodes you rely on so they survive decay; record decisions, observations, and problems - not todos. Querying, relating and starting sessions only update usage metrics (decay and activation scores) that weight future results; only kg_node_update changes node content.';

type McpRouteEnv = { Variables: { claims: KgTokenPayload; requestId: string; abortSignal?: AbortSignal } };

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const preAuthLimits = new Map<string, RateLimitEntry>();
const postAuthLimits = new Map<string, RateLimitEntry>();

const PRE_AUTH_RATE = 100;
const POST_AUTH_RATE = 1000;
const RATE_WINDOW_MS = 60_000;
const MAX_BODY_SIZE = 1024 * 1024;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of preAuthLimits) {
    if (entry.resetAt < now) preAuthLimits.delete(key);
  }
  for (const [key, entry] of postAuthLimits) {
    if (entry.resetAt < now) postAuthLimits.delete(key);
  }
}, 5 * 60 * 1000);

function checkRateLimit(
  store: Map<string, RateLimitEntry>,
  key: string,
  limit: number
): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  let entry = store.get(key);

  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    store.set(key, entry);
  }

  entry.count++;

  if (entry.count > limit) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, retryAfter };
  }

  return { allowed: true };
}

function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  if (env.TRUSTED_PROXY_CIDR) {
    const xff = c.req.header('X-Forwarded-For');
    if (xff) {
      const firstIp = xff.split(',')[0].trim();
      if (firstIp) return firstIp;
    }
  }

  const cfIp = c.req.header('CF-Connecting-IP');
  if (cfIp) return cfIp;

  const realIp = c.req.header('X-Real-IP');
  if (realIp) return realIp;

  return 'unknown';
}

function negotiateVersion(requested: unknown): string {
  if (typeof requested !== 'string' || requested === '') {
    return NEWEST_VERSION;
  }
  if ((SUPPORTED_VERSIONS as readonly string[]).includes(requested)) {
    return requested;
  }
  return NEWEST_VERSION;
}

function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined && { data }) } };
}

function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/** A tool-level failure: a successful JSON-RPC response whose result is flagged isError. */
function toolFailure(id: string | number | null, text: string): JsonRpcResponse {
  return rpcResult(id, { content: [{ type: 'text', text }], isError: true });
}

interface RpcCall {
  id: string | number | null;
  params: Record<string, unknown> | undefined;
  claims: KgTokenPayload;
  abortSignal: AbortSignal | undefined;
}

type MethodHandler = (call: RpcCall) => Promise<JsonRpcResponse>;

async function resolveCurrentSession(db: KgDbClient, tenantId: string): Promise<string | null> {
  // CRITICAL: Filter by tenant to prevent cross-tenant session resolution
  // (resolveActiveSession's query already enforces this; kept as an
  // explicit comment here since this result gates every write tool).
  const session = await resolveActiveSession(db, tenantId);
  return session?.id ?? null;
}

export function resetRateLimits(): void {
  preAuthLimits.clear();
  postAuthLimits.clear();
}

export function createMcpRoutes(deps: {
  dbFactory: DbFactory;
  embed: EmbeddingProvider;
  toolRegistry: ToolRegistry;
}): Hono<McpRouteEnv> {
  const { dbFactory, embed, toolRegistry } = deps;
  const routes = new Hono<McpRouteEnv>();

  const toolSchemaCache = new Map<string, object>();
  function getToolJsonSchema(tool: { name: string; inputSchema: z.ZodType }): object {
    let cached = toolSchemaCache.get(tool.name);
    if (!cached) {
      try {
        // Use Zod 4 native JSON Schema generation
        // unrepresentable: 'any' handles transforms by outputting {} (matches anything)
        const rawSchema = tool.inputSchema.toJSONSchema({ unrepresentable: 'any' });
        // Strip $schema - MCP embeds these, doesn't need the meta reference
        const schema: Record<string, unknown> = { ...rawSchema };
        delete schema.$schema;
        cached = schema;
      } catch (err) {
        logger.warn({ tool: tool.name, err }, 'Failed to generate JSON schema, using fallback');
        cached = { type: 'object', properties: {}, additionalProperties: true };
      }
      toolSchemaCache.set(tool.name, cached);
    }
    return cached;
  }

  const initialize: MethodHandler = async ({ id, params }) =>
    rpcResult(id, {
      protocolVersion: negotiateVersion(params?.protocolVersion),
      serverInfo: {
        name: env.MCP_SERVER_NAME,
        title: 'Komplyt Zero',
        version: packageJson.version,
        iconUrl: env.KG_PUBLIC_URL ? `${env.KG_PUBLIC_URL}/icon.png` : undefined,
      },
      capabilities: { tools: {} },
      instructions: MCP_INSTRUCTIONS,
    });

  const ping: MethodHandler = async ({ id }) => rpcResult(id, {});

  const listTools: MethodHandler = async ({ id, params }) => {
    // The list is not paginated, so no cursor can be valid (spec: invalid cursor = -32602).
    if (params?.cursor !== undefined) return jsonRpcError(id, -32602, 'Invalid params: invalid cursor');
    return rpcResult(id, {
      tools: toolRegistry.list().map((t) => ({
        name: t.name,
        title: t.annotations?.title,
        description: t.description,
        inputSchema: getToolJsonSchema(t),
        annotations: t.annotations,
      })),
    });
  };

  const callTool: MethodHandler = async ({ id, params, claims, abortSignal }) => {
    const name = params?.name;
    if (typeof name !== 'string') return jsonRpcError(id, -32602, 'Invalid params: name required');

    // Old names stay callable (never listed) until LEGACY_TOOLS_UNTIL: see tools/legacy.ts
    const tool = toolRegistry.get(name as ToolName) ?? getLegacyTool(name);
    if (!tool) return toolFailure(id, `Unknown tool: ${name}`);

    try {
      requireScope(tool.requiredScope, claims);
    } catch (err) {
      if (err instanceof AuthError) return toolFailure(id, err.message);
      throw err;
    }

    const parsed = tool.inputSchema.safeParse(params?.arguments ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return jsonRpcError(id, -32602, `Invalid params: ${issues}`);
    }

    const db = await dbFactory.createScoped(claims, abortSignal);
    try {
      const ctx: ToolContext = {
        claims,
        tenantId: claims.tenantId,
        projects: claims.projects,
        scope: claims.scope,
        currentSession: await resolveCurrentSession(db, claims.tenantId),
      };
      return rpcResult(id, await tool.execute(db, embed, ctx, parsed.data));
    } finally {
      await (db.release ? db.release() : db.close()).catch(() => {});
    }
  };

  const methods = new Map<string, MethodHandler>([
    ['initialize', initialize],
    ['ping', ping],
    ['tools/list', listTools],
    ['tools/call', callTool],
  ]);

  routes.get('/', (c) => {
    c.res.headers.set('Allow', 'POST');
    return c.text('Method Not Allowed', 405);
  });

  routes.post('/', async (c) => {
    const clientIp = getClientIp(c);
    const publicUrl = env.KG_PUBLIC_URL;

    const preAuthCheck = checkRateLimit(preAuthLimits, clientIp, PRE_AUTH_RATE);
    if (!preAuthCheck.allowed) {
      c.res.headers.set('Retry-After', String(preAuthCheck.retryAfter));
      return c.text('Too Many Requests', 429);
    }

    // KG_AUTH_MODE=local: one fixed identity, the Authorization header is not looked at.
    const localClaims = getLocalModeClaims();
    const authHeader = c.req.header('Authorization');
    if (!localClaims && !authHeader?.startsWith('Bearer ')) {
      logger.warn({ hasAuth: !!authHeader, authPrefix: authHeader?.slice(0, 20) }, 'MCP: Missing or invalid Authorization header');
      if (publicUrl) {
        c.res.headers.set('WWW-Authenticate', wwwAuthenticateHeader(publicUrl));
      }
      return c.text('Unauthorized', 401);
    }

    const token = authHeader?.slice(7) ?? '';
    let claims: KgTokenPayload;

    try {
      claims = localClaims ?? (await validateToken(token));
      // Identity is logged once per request, on the 'Request completed' line in
      // index.ts, which also carries status, duration and requestId. Keeping
      // this line at info would put a second sub-carrying line per request into
      // Better Stack and double every per-user count on the usage dashboard.
      c.set('claims', claims);
      logger.debug(
        { sub: claims.sub, tenantId: claims.tenantId, scope: claims.scope, requestId: c.get('requestId') },
        'MCP: Token validated',
      );
    } catch (err) {
      logger.error({ err, tokenLength: token.length, tokenPrefix: token.slice(0, 20) }, 'MCP: Token validation failed');
      if (publicUrl) {
        c.res.headers.set('WWW-Authenticate', wwwAuthenticateHeader(publicUrl));
      }
      if (err instanceof AuthError) {
        return c.text(err.message, err.statusCode as 401 | 403 | 503);
      }
      return c.text('Unauthorized', 401);
    }

    const rateLimitKey = `${claims.tenantId}:${claims.sub}`;
    const postAuthCheck = checkRateLimit(postAuthLimits, rateLimitKey, POST_AUTH_RATE);
    if (!postAuthCheck.allowed) {
      c.res.headers.set('Retry-After', String(postAuthCheck.retryAfter));
      return c.text('Too Many Requests', 429);
    }

    const contentLength = parseInt(c.req.header('Content-Length') || '0', 10);
    if (contentLength > MAX_BODY_SIZE) {
      return c.text('Payload Too Large', 413);
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(jsonRpcError(null, -32700, 'Parse error'), 400);
    }

    if (Array.isArray(rawBody)) {
      return c.json(jsonRpcError(null, -32600, 'Batch requests not supported'), 400);
    }

    const body = rawBody as JsonRpcRequest;

    if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return c.json(jsonRpcError(null, -32600, 'Invalid Request'), 400);
    }

    const isNotification = !('id' in body);
    if (isNotification) {
      return new Response(null, { status: 202 });
    }

    const requestId = body.id ?? null;

    const handler = methods.get(body.method);
    let response: JsonRpcResponse;
    try {
      response = handler
        ? await handler({
            id: requestId,
            params: body.params,
            claims,
            abortSignal: c.get('abortSignal') as AbortSignal | undefined,
          })
        : jsonRpcError(requestId, -32601, `Method not found: ${body.method}`);
    } catch (err) {
      logger.error({ err, method: body.method }, 'MCP request failed');
      const errMessage = err instanceof Error ? err.message : String(err);
      // Surface actual error in DEV mode for debugging
      response = jsonRpcError(requestId, -32603, env.DEV_SURFACE_ERRORS ? errMessage : 'Internal error');
    }

    // Check if client prefers SSE (MCP Streamable HTTP transport)
    const acceptHeader = c.req.header('Accept') || '';
    const prefersSSE = acceptHeader.includes('text/event-stream');

    if (prefersSSE) {
      // Return SSE stream with single response event
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ data: JSON.stringify(response) });
      });
    }

    return c.json(response);
  });

  return routes;
}
