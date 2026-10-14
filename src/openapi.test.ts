import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import type {
  DbFactory,
  EmbeddingProvider,
  KgDbClient,
  KgTokenPayload,
  ToolContext,
  ToolHandler,
  ToolName,
  ToolRegistry,
  ToolResult,
} from './contracts.js';
import { ERROR_HTTP_STATUS, ErrorCode, TOOL_SCOPES, toolError, toolSuccess } from './contracts.js';
import type { ErrorHandlerEnv } from './http-errors.js';

// Requests without an Authorization header go through the real auth
// middleware (real 401). With one, JWT verification is replaced by a
// header-driven claims stub: validateToken grants an implicit kg:read kg:write
// to every verified token, so a read-only token can only be built
// here. Scope checks (requireScope), validation and dispatch stay real.
// x-test-tenant overrides the tenant so rate-limit buckets can be separated.
vi.mock('./auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth.js')>();
  const createAuthMiddleware: typeof actual.createAuthMiddleware = () => {
    const real = actual.createAuthMiddleware();
    return async (c, next) => {
      if (!c.req.header('Authorization')) return real(c, next);
      const claims: KgTokenPayload = {
        sub: 'user:test',
        tenantId: c.req.header('x-test-tenant') ?? 't-openapi',
        projects: [],
        scope: c.req.header('x-test-scope') ?? 'kg:read kg:write',
        principals: [],
        tier: 'free',
      };
      c.set('claims', claims);
      await next();
    };
  };
  return { ...actual, createAuthMiddleware };
});

const { createOpenApiRoutes } = await import('./openapi.js');
const { createErrorHandler } = await import('./http-errors.js');
const { PoolExhaustedError, CircuitBreakerOpenError } = await import('./pool.js');

type Route = { method: 'GET' | 'POST'; path: string; body: Record<string, unknown>; tool: ToolName };

const ROUTES: Route[] = [
  { method: 'POST', path: '/node/create', body: { type: 'decision', content: 'x' }, tool: 'kg_node_create' },
  { method: 'POST', path: '/query', body: { text: 'x' }, tool: 'kg_query' },
  { method: 'POST', path: '/node/update', body: { id: 'node:1', status: 'done' }, tool: 'kg_node_update' },
  { method: 'POST', path: '/relate', body: { from: 'node:1', to: 'node:2' }, tool: 'kg_relate' },
  { method: 'POST', path: '/session/start', body: { project: 'p' }, tool: 'kg_session_start' },
  { method: 'POST', path: '/session/end', body: {}, tool: 'kg_session_end' },
  { method: 'GET', path: '/session/info', body: {}, tool: 'kg_session_info' },
  { method: 'GET', path: '/status', body: {}, tool: 'kg_status' },
];

const WRITE_ROUTES = ROUTES.filter((r) => TOOL_SCOPES[r.tool] === 'kg:write');

type Execute = (name: ToolName, params: unknown) => Promise<ToolResult>;
type Call = { name: ToolName; params: unknown; ctx: ToolContext };

function fakeTool(name: ToolName, execute: Execute, calls: Call[]): ToolHandler {
  return {
    name,
    description: `fake ${name}`,
    inputSchema: z.unknown(),
    responseSchema: z.unknown(),
    requiredScope: TOOL_SCOPES[name],
    annotations: {
      title: name,
      readOnlyHint: TOOL_SCOPES[name] === 'kg:read',
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    execute: async (_db, _embed, ctx, params) => {
      calls.push({ name, params, ctx });
      return execute(name, params);
    },
  };
}

function makeApp(
  options: { execute?: Execute; registered?: boolean; rateLimit?: { limit: number; windowMs: number } } = {},
) {
  const { execute = async (name) => toolSuccess({ ok: true, tool: name }), registered = true, rateLimit } = options;
  const calls: Call[] = [];
  let closed = 0;

  const db: KgDbClient = {
    query: async () => [],
    queryOne: async () => null,
    close: async () => {
      closed++;
    },
  };
  const dbFactory: DbFactory = { createScoped: async () => db };
  const embed: EmbeddingProvider = { embedDocuments: async () => [], embedQuery: async () => [], model: 'test-mock', dimensions: 0 };
  const toolRegistry: ToolRegistry = {
    list: () => [],
    get: (name) => (registered ? fakeTool(name, execute, calls) : undefined),
  };

  // The production global error handler (index.ts), with a spy logger.
  const logger = { debug: vi.fn(), error: vi.fn() };
  const app = new Hono<ErrorHandlerEnv>();
  app.onError(createErrorHandler(logger));
  app.route('/api/v1', createOpenApiRoutes({ dbFactory, embed, toolRegistry, rateLimit }));
  return { app, calls, logger, closedCount: () => closed };
}

function send(
  app: Hono<ErrorHandlerEnv>,
  route: Pick<Route, 'method' | 'path' | 'body'>,
  opts: { auth?: boolean; scope?: string; tenant?: string } = {},
) {
  const { auth = true, scope, tenant } = opts;
  const headers: Record<string, string> = {};
  if (auth) headers.Authorization = 'Bearer test-token';
  if (scope) headers['x-test-scope'] = scope;
  if (tenant) headers['x-test-tenant'] = tenant;
  if (route.method === 'GET') {
    const qs = new URLSearchParams(route.body as Record<string, string>).toString();
    return app.request(`/api/v1${route.path}${qs ? `?${qs}` : ''}`, { headers });
  }
  return app.request(`/api/v1${route.path}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(route.body),
  });
}

describe('OpenAPI routes: dispatch', () => {
  it.each(ROUTES)('$method $path dispatches $tool', async (route) => {
    const { app, calls, closedCount } = makeApp();
    const res = await send(app, route);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, tool: route.tool });
    expect(calls.map((c) => c.name)).toEqual([route.tool]);
    expect(closedCount()).toBe(1);
  });

  it('forwards the validated JSON body as params, with the tenant from the claims', async () => {
    const { app, calls } = makeApp();
    const body = { type: 'decision', content: 'use bun', project: 'kg', tags: ['a', 'b'] };
    const res = await send(app, { method: 'POST', path: '/node/create', body });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual(body);
    expect(calls[0].ctx.tenantId).toBe('t-openapi');
    expect(calls[0].ctx.claims.tenantId).toBe('t-openapi');
  });

  it('forwards the validated query string as params', async () => {
    const { app, calls } = makeApp();
    const res = await send(app, { method: 'GET', path: '/status', body: { project: 'kg' } }, { tenant: 't-forward' });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({ project: 'kg' });
    expect(calls[0].ctx.tenantId).toBe('t-forward');
  });

  it('read routes accept a read-only token', async () => {
    const { app, calls } = makeApp();
    for (const route of ROUTES.filter((r) => TOOL_SCOPES[r.tool] === 'kg:read')) {
      expect((await send(app, route, { scope: 'kg:read' })).status, route.path).toBe(200);
    }
    expect(calls).toHaveLength(3);
  });
});

describe('OpenAPI routes: auth', () => {
  it.each(ROUTES)('$method $path without a token returns 401', async (route) => {
    const { app, calls } = makeApp();
    const res = await send(app, route, { auth: false });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: ErrorCode.AUTH, message: 'Missing or invalid Authorization header' },
    });
    expect(calls).toEqual([]);
  });

  it('serves /openapi.json without a token', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const spec = await res.json();
    expect(Object.keys(spec.paths)).toHaveLength(ROUTES.length);
    for (const route of ROUTES) {
      const op = spec.paths[route.path][route.method.toLowerCase()];
      expect(Object.keys(op.responses).sort(), route.path).toEqual(['200', '400', '401', '403', '404', '429', '500', '503']);
    }
  });

  it.each(WRITE_ROUTES)('$method $path rejects a kg:read token with 403', async (route) => {
    const { app, calls } = makeApp();
    const res = await send(app, route, { scope: 'kg:read' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: ErrorCode.AUTH, message: "Scope 'kg:write' required" } });
    expect(calls).toEqual([]);
  });
});

describe('OpenAPI routes: validation', () => {
  it('rejects an empty node id on update (schema min(1)) with the declared error body', async () => {
    const { app, calls } = makeApp();
    const res = await send(app, { method: 'POST', path: '/node/update', body: { id: '' } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: { code: ErrorCode.VALIDATION, message: expect.stringMatching(/^id: /) } });
    expect(calls).toEqual([]);
  });

  it('returns 400 with the declared error body for a malformed JSON body', async () => {
    const { app, calls, logger } = makeApp();
    const res = await app.request('/api/v1/query', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: '{"text": ',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: ErrorCode.VALIDATION, message: 'Malformed JSON in request body' } });
    expect(calls).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('OpenAPI routes: global error handler', () => {
  it('maps PoolExhaustedError to 503 with Retry-After: 1', async () => {
    const { app, closedCount } = makeApp({
      execute: async () => {
        throw new PoolExhaustedError('pool full: 10/10 in use');
      },
    });
    const res = await send(app, ROUTES[0]);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1');
    expect(await res.json()).toEqual({
      error: { code: ErrorCode.RATE_LIMIT, message: 'Service temporarily unavailable' },
    });
    expect(closedCount()).toBe(1);
  });

  it('maps CircuitBreakerOpenError to 503 with the breaker cooldown as Retry-After', async () => {
    const breaker = new CircuitBreakerOpenError();
    const { app } = makeApp({
      execute: async () => {
        throw breaker;
      },
    });
    const res = await send(app, ROUTES[1]);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe(String(breaker.retryAfter));
    expect(await res.json()).toEqual({
      error: { code: ErrorCode.RATE_LIMIT, message: 'Service temporarily unavailable' },
    });
  });

  it('answers an unexpected error with a generic 500 that does not leak its message', async () => {
    const { app, logger, closedCount } = makeApp({
      execute: async () => {
        throw new Error('connection to db.internal:8000 failed for user root');
      },
    });
    const res = await send(app, ROUTES[0]);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: ErrorCode.INTERNAL, message: 'Internal server error' } });
    expect(text).not.toContain('db.internal');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(closedCount()).toBe(1);
  });
});

describe('OpenAPI routes: rate limiting', () => {
  // The limiter store is module-level, so these tenant ids are used nowhere else.
  it('limits each tenant separately', async () => {
    const { app, calls } = makeApp({ rateLimit: { limit: 2, windowMs: 60_000 } });
    const route = ROUTES.find((r) => r.path === '/status')!;

    expect((await send(app, route, { tenant: 'rl-tenant-a' })).status).toBe(200);
    expect((await send(app, route, { tenant: 'rl-tenant-a' })).status).toBe(200);
    const limited = await send(app, route, { tenant: 'rl-tenant-a' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBeTruthy();
    expect(await limited.json()).toEqual({ error: { code: ErrorCode.RATE_LIMIT, message: 'Rate limit exceeded' } });

    expect((await send(app, route, { tenant: 'rl-tenant-b' })).status).toBe(200);
    expect(calls.map((c) => c.ctx.tenantId)).toEqual(['rl-tenant-a', 'rl-tenant-a', 'rl-tenant-b']);
  });
});

describe('OpenAPI routes: tool results', () => {
  const ERROR_CODES = Object.keys(ERROR_HTTP_STATUS) as Array<keyof typeof ERROR_HTTP_STATUS>;

  it.each(ERROR_CODES)('toolError(%s) maps to its HTTP status', async (code) => {
    const { app, closedCount } = makeApp({ execute: async () => toolError(code, `failed: ${code}`) });
    const res = await send(app, ROUTES[0]);
    expect(res.status).toBe(ERROR_HTTP_STATUS[code]);
    expect(await res.json()).toEqual({ error: { code, message: `failed: ${code}` } });
    expect(closedCount()).toBe(1);
  });

  it('returns 404 for a tool missing from the registry', async () => {
    const { app, closedCount } = makeApp({ registered: false });
    const res = await send(app, ROUTES[1]);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: ErrorCode.NOT_FOUND, message: 'Unknown tool: kg_query' } });
    expect(closedCount()).toBe(1);
  });

  it('returns the tool JSON on success', async () => {
    const payload = { action: 'created', id: 'node:1', nested: { n: [1, 2] } };
    const { app } = makeApp({ execute: async () => toolSuccess(payload) });
    const res = await send(app, ROUTES[0]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });
});

describe('OpenAPI routes: removed legacy paths', () => {
  it.each(['/record', '/update', '/session'])('POST %s returns 404', async (path) => {
    const { app, calls } = makeApp();
    expect((await send(app, { method: 'POST', path, body: {} })).status).toBe(404);
    expect(calls).toEqual([]);
  });
});
