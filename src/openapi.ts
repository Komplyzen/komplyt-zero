import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context, TypedResponse } from 'hono';
import { createAuthMiddleware, requireScope } from './auth.js';
import {
  DbFactory,
  KgTokenPayload,
  ToolContext,
  ToolRegistry,
  EmbeddingProvider,
  ToolName,
  ToolResult,
  nodeCreateParamsSchema,
  queryParamsSchema,
  nodeUpdateParamsSchema,
  relateParamsSchema,
  sessionStartParamsSchema,
  sessionEndParamsSchema,
  sessionInfoParamsSchema,
  statusParamsSchema,
  nodeCreateResponseSchema,
  queryResponseSchema,
  nodeUpdateResponseSchema,
  relateResponseSchema,
  sessionStartResponseSchema,
  sessionInfoResponseSchema,
  sessionEndResponseSchema,
  statusResponseSchema,
  ERROR_HTTP_STATUS,
  ErrorCode,
} from './contracts.js';
import { createRateLimiter } from './rate-limit.js';
import { env } from './env.js';

type RouteEnv = { Variables: { claims: KgTokenPayload; requestId: string; abortSignal?: AbortSignal } };

const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// Error statuses every route can produce: 400 from request validation or a
// tool's INVALID_INPUT/NO_SESSION, 401/403 from auth and requireScope, 404 for
// NOT_FOUND or an unregistered tool, 429 from the rate limiter or RATE_LIMITED,
// 500 for INTERNAL or unhandled errors, 503 when the DB pool or JWKS is unavailable.
const errorJson = (description: string) => ({
  description,
  content: { 'application/json': { schema: errorResponseSchema } },
});

const errorResponses = {
  400: errorJson('Validation error or no active session'),
  401: errorJson('Missing or invalid bearer token'),
  403: errorJson('Token lacks the required scope'),
  404: errorJson('Node or tool not found'),
  429: errorJson('Rate limit exceeded'),
  500: errorJson('Internal server error'),
  503: errorJson('Service temporarily unavailable'),
} as const;

// Route definitions
const nodeCreateRoute = createRoute({
  method: 'post',
  path: '/node/create',
  tags: ['knowledge'],
  summary: 'Create a knowledge node',
  description: 'Create a new node in the knowledge graph with automatic embedding generation.',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: nodeCreateParamsSchema } } },
  },
  responses: {
    200: { description: 'Node created', content: { 'application/json': { schema: nodeCreateResponseSchema } } },
    ...errorResponses,
  },
});

const queryRoute = createRoute({
  method: 'post',
  path: '/query',
  tags: ['knowledge'],
  summary: 'Query the knowledge graph',
  description: 'Search nodes by semantic similarity, filters, or spreading activation.',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: queryParamsSchema } } },
  },
  responses: {
    200: { description: 'Query results', content: { 'application/json': { schema: queryResponseSchema } } },
    ...errorResponses,
  },
});

const nodeUpdateRoute = createRoute({
  method: 'post',
  path: '/node/update',
  tags: ['knowledge'],
  summary: 'Update a knowledge node',
  description: 'Update node status or content. Content changes regenerate the embedding.',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: nodeUpdateParamsSchema } } },
  },
  responses: {
    200: { description: 'Node updated', content: { 'application/json': { schema: nodeUpdateResponseSchema } } },
    ...errorResponses,
  },
});

const relateRoute = createRoute({
  method: 'post',
  path: '/relate',
  tags: ['knowledge'],
  summary: 'Create or reinforce an edge',
  description: 'Create a relationship between two nodes, or reinforce an existing one.',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: relateParamsSchema } } },
  },
  responses: {
    200: { description: 'Edge created/reinforced', content: { 'application/json': { schema: relateResponseSchema } } },
    ...errorResponses,
  },
});

const sessionStartRoute = createRoute({
  method: 'post',
  path: '/session/start',
  tags: ['session'],
  summary: 'Start a session',
  description: 'Start a new session. Applies decay to existing nodes.',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: sessionStartParamsSchema } } },
  },
  responses: {
    200: { description: 'Session started', content: { 'application/json': { schema: sessionStartResponseSchema } } },
    ...errorResponses,
  },
});

const sessionEndRoute = createRoute({
  method: 'post',
  path: '/session/end',
  tags: ['session'],
  summary: 'End the current session',
  description: 'End the current session. Nodes and edges are kept.',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: sessionEndParamsSchema } } },
  },
  responses: {
    200: { description: 'Session ended', content: { 'application/json': { schema: sessionEndResponseSchema } } },
    ...errorResponses,
  },
});

const sessionInfoRoute = createRoute({
  method: 'get',
  path: '/session/info',
  tags: ['session'],
  summary: 'Get current session info',
  description: 'Get details of the current session and node counts by type.',
  security: [{ bearerAuth: [] }],
  request: {
    query: sessionInfoParamsSchema,
  },
  responses: {
    200: { description: 'Session info', content: { 'application/json': { schema: sessionInfoResponseSchema } } },
    ...errorResponses,
  },
});

const statusRoute = createRoute({
  method: 'get',
  path: '/status',
  tags: ['session'],
  summary: 'Get knowledge graph status',
  description: 'Get current session info, node counts, open todos/problems, and recent decisions.',
  security: [{ bearerAuth: [] }],
  request: {
    query: statusParamsSchema,
  },
  responses: {
    200: { description: 'Status response', content: { 'application/json': { schema: statusResponseSchema } } },
    ...errorResponses,
  },
});

/** Per-tenant REST rate limit: requests allowed per window. */
export interface RestRateLimit {
  limit: number;
  windowMs: number;
}

const DEFAULT_RATE_LIMIT: RestRateLimit = { limit: 500, windowMs: 60_000 };

/** "path: message" of the first zod issue; zod messages describe the expected shape, not the input value. */
function describeValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid request';
  const path = issue.path.map(String).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

export function createOpenApiRoutes(deps: {
  dbFactory: DbFactory;
  embed: EmbeddingProvider;
  toolRegistry: ToolRegistry;
  rateLimit?: RestRateLimit;
}): OpenAPIHono<RouteEnv> {
  const { dbFactory, embed, toolRegistry, rateLimit = DEFAULT_RATE_LIMIT } = deps;
  // Request validation failures answer with the declared errorResponseSchema
  // body instead of the library's default ZodError dump.
  const app = new OpenAPIHono<RouteEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          { error: { code: ErrorCode.VALIDATION, message: describeValidationError(result.error) } },
          400,
        );
      }
    },
  });

  // OpenAPI spec endpoint (public, before auth middleware)
  app.doc('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Knowledge Graph API',
      version: '1.0.0',
      description: 'Multi-tenant REST API for knowledge graph access',
    },
    servers: [{ url: env.KG_PUBLIC_URL ? `${env.KG_PUBLIC_URL}/api/v1` : `http://${env.LISTEN_ADDR}`, description: 'API Server' }],
    security: [{ bearerAuth: [] }],
  });

  // Register security scheme
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });

  // Auth required for all other API routes
  app.use('*', createAuthMiddleware());

  // Rate limiting per tenant (default 500/min)
  app.use(
    '*',
    createRateLimiter({
      limit: rateLimit.limit,
      windowMs: rateLimit.windowMs,
      keyGenerator: (c) => c.get('claims').tenantId,
    }),
  );

  // Helper to execute tool and return response
  async function runTool(
    c: Context<RouteEnv>,
    toolName: ToolName,
    params: unknown,
    requiredScope: 'kg:read' | 'kg:write',
  ): Promise<TypedResponse> {
    const claims = c.get('claims');
    requireScope(requiredScope, claims);

    const abortSignal = c.get('abortSignal');
    const db = await dbFactory.createScoped(claims, abortSignal);
    try {
      const tool = toolRegistry.get(toolName);
      if (!tool) {
        return c.json({ error: { code: ErrorCode.NOT_FOUND, message: `Unknown tool: ${toolName}` } }, 404);
      }

      const ctx: ToolContext = {
        claims,
        tenantId: claims.tenantId,
        projects: claims.projects,
        scope: claims.scope,
        currentSession: null,
      };

      const result: ToolResult = await tool.execute(db, embed, ctx, params);

      if (result.isError && result.errorCode) {
        return c.json(
          { error: { code: result.errorCode, message: result.content[0].text } },
          ERROR_HTTP_STATUS[result.errorCode],
        );
      }

      return c.json(JSON.parse(result.content[0].text));
    } finally {
      await db.close();
    }
  }

  // The one cast in this router. Checked: request params (zod via
  // c.req.valid), claims/abortSignal (RouteEnv), and the error body shape
  // (built here in runTool). Not checked: the success body, which is the tool's
  // JSON text parsed at runtime (unknown), nor that an error status is one the
  // route declares; the cast narrows to the route's typed response on that trust.
  async function executeTool<TRes extends TypedResponse>(
    c: Context<RouteEnv>,
    toolName: ToolName,
    params: unknown,
    requiredScope: 'kg:read' | 'kg:write',
  ): Promise<TRes> {
    const res = await runTool(c, toolName, params, requiredScope);
    return res as TRes;
  }

  // Register routes
  app.openapi(nodeCreateRoute, (c) => executeTool(c, 'kg_node_create', c.req.valid('json'), 'kg:write'));
  app.openapi(queryRoute, (c) => executeTool(c, 'kg_query', c.req.valid('json'), 'kg:read'));
  app.openapi(nodeUpdateRoute, (c) => executeTool(c, 'kg_node_update', c.req.valid('json'), 'kg:write'));
  app.openapi(relateRoute, (c) => executeTool(c, 'kg_relate', c.req.valid('json'), 'kg:write'));
  app.openapi(sessionStartRoute, (c) => executeTool(c, 'kg_session_start', c.req.valid('json'), 'kg:write'));
  app.openapi(sessionEndRoute, (c) => executeTool(c, 'kg_session_end', c.req.valid('json'), 'kg:write'));
  app.openapi(sessionInfoRoute, (c) => executeTool(c, 'kg_session_info', c.req.valid('query'), 'kg:read'));
  app.openapi(statusRoute, (c) => executeTool(c, 'kg_status', c.req.valid('query'), 'kg:read'));

  return app;
}
