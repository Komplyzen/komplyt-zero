import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ToolHandler } from './contracts.js';

vi.mock('./env.js', () => ({
  env: {
    KG_PUBLIC_URL: 'https://kg.example.com',
    MCP_SERVER_NAME: 'komplyt-zero',
    TRUSTED_PROXY_CIDR: '10.0.0.0/8',
    KG_DB_URL: 'ws://localhost:8000',
    KG_DB_USER: 'root',
    KG_DB_PASS: 'root',
    KG_DB_NS: 'kg',
    KG_DB_NAME: 'test',
    KG_JWT_SECRET: 'test-secret-that-is-at-least-32-characters',
    COHERE_API_KEY: 'test-key',
    LOG_LEVEL: 'error',
  },
}));

vi.mock('./auth.js', () => ({
  validateToken: vi.fn(),
  requireScope: vi.fn(),
  AuthError: class AuthError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  },
  buildPrincipals: vi.fn(() => ['principal:user_test']),
  wwwAuthenticateHeader: vi.fn((url: string) => `Bearer resource_metadata="${url}/.well-known/oauth-protected-resource"`),
}));

const mockDbClient = {
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockDbFactory = {
  createScoped: vi.fn().mockResolvedValue(mockDbClient),
};

const mockEmbed = {
  embedDocuments: vi.fn().mockResolvedValue([]),
  embedQuery: vi.fn().mockResolvedValue([]),
  model: 'test-mock',
  dimensions: 1024 as const,
};

const mockToolResult = {
  content: [{ type: 'text' as const, text: '{"status":"ok"}' }],
};

const mockInputSchema = z.object({
  text: z.string().optional(),
  limit: z.number().default(10),
});

const mockTool: ToolHandler = {
  name: 'kg_query',
  description: 'Query the knowledge graph',
  inputSchema: mockInputSchema,
  responseSchema: z.unknown(),
  requiredScope: 'kg:read',
  annotations: {
    title: 'Query Knowledge',
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  execute: vi.fn().mockResolvedValue(mockToolResult),
};

const mockToolRegistry = {
  list: vi.fn(() => [mockTool]),
  get: vi.fn((name: string) => (name === 'kg_query' ? mockTool : undefined)),
};

import { createMcpRoutes, resetRateLimits } from './mcp.js';
import { AuthError, validateToken } from './auth.js';

function createTestApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.res.headers.set('X-Request-Id', 'test-request-id');
    await next();
  });
  app.route('/mcp', createMcpRoutes({
    dbFactory: mockDbFactory,
    embed: mockEmbed,
    toolRegistry: mockToolRegistry,
  }));
  return app;
}

describe('MCP Protocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    (validateToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      sub: 'user:test',
      tenantId: 'tenant-1',
      projects: [],
      scope: 'kg:read kg:write',
      principals: ['principal:user_test'],
    });
  });

  describe('CAP-5: GET returns 405', () => {
    it('returns 405 with Allow header for GET requests', async () => {
      const app = createTestApp();
      const res = await app.request('/mcp', {
        method: 'GET',
        headers: { Authorization: 'Bearer valid-token' },
      });

      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('POST');
    });
  });

  describe('CAP-3: Batch rejection', () => {
    it('returns -32600 for array payload', async () => {
      const app = createTestApp();
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe(-32600);
      expect(body.error.message).toBe('Batch requests not supported');
    });

    it('returns -32600 for empty array', async () => {
      const app = createTestApp();
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([]),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe(-32600);
    });
  });

  describe('CAP-6: Notifications', () => {
    it('returns 202 empty for request without id', async () => {
      const app = createTestApp();
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });

      expect(res.status).toBe(202);
      const text = await res.text();
      expect(text).toBe('');
    });

    it('processes request with id: null as valid request', async () => {
      const app = createTestApp();
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBeNull();
      expect(body.result).toEqual({});
    });
  });

  describe('CAP-7: Ping', () => {
    it('returns empty result object', async () => {
      const app = createTestApp();
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: {},
      });
    });
  });

  describe('CAP-2: Version negotiation', () => {
    it('returns requested version when supported', async () => {
      const app = createTestApp();
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05' },
        }),
      });

      const body = await res.json();
      expect(body.result.protocolVersion).toBe('2024-11-05');
    });

    it('falls back to newest for unsupported version', async () => {
      const app = createTestApp();
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '1999-01-01' },
        }),
      });

      const body = await res.json();
      expect(body.result.protocolVersion).toBe('2025-06-18');
    });

    it('defaults to newest when omitted', async () => {
      const app = createTestApp();
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        }),
      });

      const body = await res.json();
      expect(body.result.protocolVersion).toBe('2025-06-18');
    });
  });

  describe('CAP-4: Instructions field', () => {
    it('includes instructions in initialize response', async () => {
      const app = createTestApp();
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        }),
      });

      const body = await res.json();
      expect(body.result.instructions).toBe(
        'Persistent knowledge graph memory. Query before recording to avoid duplicates; activate (kg_node_update) nodes you rely on so they survive decay; record decisions, observations, and problems - not todos. Querying, relating and starting sessions only update usage metrics (decay and activation scores) that weight future results; only kg_node_update changes node content.'
      );
    });
  });

  describe('CAP-9: Server identity', () => {
    it('returns correct server name', async () => {
      const app = createTestApp();
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        }),
      });

      const body = await res.json();
      expect(body.result.serverInfo.name).toBe('komplyt-zero');
    });
  });

  describe('CAP-8: WWW-Authenticate header', () => {
    it('returns WWW-Authenticate on missing auth', async () => {
      const app = createTestApp();
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });

      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe(
        'Bearer resource_metadata="https://kg.example.com/.well-known/oauth-protected-resource"'
      );
    });

    it('returns WWW-Authenticate on invalid token', async () => {
      (validateToken as ReturnType<typeof vi.fn>).mockRejectedValue(
        new AuthError('Token expired', 401)
      );

      const app = createTestApp();
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer invalid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });

      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toContain('resource_metadata');
    });
  });

  describe('CAP-14: tools/list', () => {
    it('returns all tools with inputSchema', async () => {
      const app = createTestApp();
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        }),
      });

      const body = await res.json();
      expect(body.result.tools).toHaveLength(1);
      expect(body.result.tools[0]).toHaveProperty('name', 'kg_query');
      expect(body.result.tools[0]).toHaveProperty('inputSchema');
    });

    it('returns well-formed JSON schema for Claude Code compatibility', async () => {
      const app = createTestApp();
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        }),
      });

      const body = await res.json();
      const schema = body.result.tools[0].inputSchema;

      // Claude Code requires type: object and properties - empty schemas cause "Tools: (none)"
      expect(schema).toHaveProperty('type', 'object');
      expect(schema).toHaveProperty('properties');
      expect(typeof schema.properties).toBe('object');

      // Should not have $schema (we strip it for embedding in MCP)
      expect(schema).not.toHaveProperty('$schema');
    });
  });

  describe('CAP-15: Unknown tool', () => {
    it('returns tool-level error for unknown tool', async () => {
      const app = createTestApp();
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'bogus_tool' },
        }),
      });

      const body = await res.json();
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain('Unknown tool');
      expect(body.error).toBeUndefined();
    });
  });

  describe('CAP-12: Invalid params', () => {
    it('returns -32602 for invalid tool params', async () => {
      const invalidSchema = z.object({
        required_field: z.string(),
      });

      const invalidTool: ToolHandler = {
        ...mockTool,
        inputSchema: invalidSchema,
      };

      const invalidRegistry = {
        list: vi.fn(() => [invalidTool]),
        get: vi.fn((name: string) => (name === 'kg_query' ? invalidTool : undefined)),
      };

      const app = new Hono();
      app.use('*', async (c, next) => {
        c.res.headers.set('X-Request-Id', 'test-request-id');
        await next();
      });
      app.route('/mcp', createMcpRoutes({
        dbFactory: mockDbFactory,
        embed: mockEmbed,
        toolRegistry: invalidRegistry,
      }));

      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'kg_query', arguments: {} },
        }),
      });

      const body = await res.json();
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toContain('Invalid params');
    });
  });

  describe('Method not found', () => {
    it('returns -32601 for unknown method', async () => {
      const app = createTestApp();
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'unknown/method',
        }),
      });

      const body = await res.json();
      expect(body.error.code).toBe(-32601);
    });
  });


  describe('CAP-1: Stateless operation', () => {
    it('creates and closes DB connection per request', async () => {
      const app = createTestApp();
      await app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'kg_query', arguments: {} },
        }),
      });

      expect(mockDbFactory.createScoped).toHaveBeenCalledTimes(1);
      expect(mockDbClient.close).toHaveBeenCalledTimes(1);
    });

    it('ignores stale Mcp-Session-Id header', async () => {
      const app = createTestApp();
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'stale-session-id-from-old-server',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'ping',
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Mcp-Session-Id')).toBeNull();
    });
  });

  describe('Request identity on context', () => {
    // index.ts reads c.get('claims') after the route ran to put sub/tenantId
    // on the 'Request completed' log line — the only per-request identity
    // signal the Better Stack usage dashboard has.
    function createCapturingApp() {
      const seen: { claims?: unknown } = {};
      const app = new Hono();
      app.use('*', async (c, next) => {
        await next();
        seen.claims = c.get('claims' as never);
      });
      app.route('/mcp', createMcpRoutes({
        dbFactory: mockDbFactory,
        embed: mockEmbed,
        toolRegistry: mockToolRegistry,
      }));
      return { app, seen };
    }

    it('exposes validated claims to outer middleware', async () => {
      const { app, seen } = createCapturingApp();
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });

      expect(res.status).toBe(200);
      expect(seen.claims).toMatchObject({ sub: 'user:test', tenantId: 'tenant-1' });
    });

    it('leaves claims unset when the token is rejected', async () => {
      (validateToken as ReturnType<typeof vi.fn>).mockRejectedValue(new AuthError('Invalid token', 401));
      const { app, seen } = createCapturingApp();
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { Authorization: 'Bearer bad-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });

      expect(res.status).toBe(401);
      expect(seen.claims).toBeUndefined();
    });
  });
});
