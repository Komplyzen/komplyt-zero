import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import type { KgTokenPayload, ToolHandler } from './contracts.js';

const mockEnv = vi.hoisted(() => ({
  KG_AUTH_MODE: 'local' as 'local' | 'komplyt' | undefined,
  KG_LOCAL_SUB: 'local',
  KG_LOCAL_TENANT: 'local',
  KOMPLYT_JWKS_URL: undefined as string | undefined,
  KOMPLYT_ISSUER: 'https://komplyt.com',
  KOMPLYT_AUDIENCE: ['kg-server'],
  KG_PUBLIC_URL: 'https://kg.example.com',
  MCP_SERVER_NAME: 'kg-test',
  TRUSTED_PROXY_CIDR: undefined,
  LOG_LEVEL: 'error',
}));

vi.mock('./env.js', () => ({ env: mockEnv }));

import { createAuthMiddleware, AuthError } from './auth.js';
import { localClaims, getLocalModeClaims, isLocalAuthMode, localModeWarning } from './auth-local.js';
import { createMcpRoutes, resetRateLimits } from './mcp.js';

beforeEach(() => {
  mockEnv.KG_AUTH_MODE = 'local';
  mockEnv.KG_LOCAL_SUB = 'local';
  mockEnv.KG_LOCAL_TENANT = 'local';
  resetRateLimits();
});

describe('localClaims', () => {
  it('is one fixed free-tier member with read/write scope and no projects', () => {
    expect(localClaims({ KG_LOCAL_SUB: 'ada', KG_LOCAL_TENANT: 'lab-1' })).toEqual({
      sub: 'ada',
      tenantId: 'lab-1',
      projects: [],
      scope: 'kg:read kg:write',
      principals: ['principal:user_ada', 'principal:tenant_lab-1'],
      tier: 'free',
      platformRole: 'member',
    });
  });

  it('is never a platform admin, whatever the ids are called', () => {
    expect(localClaims({ KG_LOCAL_SUB: 'admin', KG_LOCAL_TENANT: 'admin' }).platformRole).toBe('member');
  });
});

describe('getLocalModeClaims', () => {
  it('returns the configured identity in local mode', () => {
    mockEnv.KG_LOCAL_SUB = 'ada';
    mockEnv.KG_LOCAL_TENANT = 'lab-1';
    expect(getLocalModeClaims()).toMatchObject({ sub: 'ada', tenantId: 'lab-1' });
  });

  it('returns null in komplyt mode, and when the mode is not set at all', () => {
    mockEnv.KG_AUTH_MODE = 'komplyt';
    expect(getLocalModeClaims()).toBeNull();
    mockEnv.KG_AUTH_MODE = undefined;
    expect(getLocalModeClaims()).toBeNull();
  });
});

describe('isLocalAuthMode', () => {
  it('is true only for KG_AUTH_MODE=local', () => {
    expect(isLocalAuthMode()).toBe(true);
    mockEnv.KG_AUTH_MODE = 'komplyt';
    expect(isLocalAuthMode()).toBe(false);
    mockEnv.KG_AUTH_MODE = undefined;
    expect(isLocalAuthMode()).toBe(false);
  });
});

describe('localModeWarning', () => {
  it('says auth is disabled and who every request is', () => {
    expect(localModeWarning({ KG_LOCAL_SUB: 'ada', KG_LOCAL_TENANT: 'lab-1' })).toBe(
      'auth disabled, every request is ada@lab-1'
    );
  });
});

describe('createAuthMiddleware (REST /api/v1 and ee routes)', () => {
  function app() {
    const a = new Hono<{ Variables: { claims: KgTokenPayload } }>();
    a.onError((err, c) =>
      err instanceof AuthError ? c.text(err.message, err.statusCode as 401) : c.text('boom', 500)
    );
    a.use('*', createAuthMiddleware());
    a.get('/who', (c) => c.json({ sub: c.get('claims').sub, tenantId: c.get('claims').tenantId }));
    return a;
  }

  it('local mode: no Authorization header is a 200 as the local user', async () => {
    const res = await app().request('/who');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: 'local', tenantId: 'local' });
  });

  it('local mode: an Authorization header is ignored, not verified', async () => {
    const res = await app().request('/who', { headers: { Authorization: 'Bearer not-a-jwt' } });
    expect(res.status).toBe(200);
  });

  it('komplyt mode: the same request without a token is a 401', async () => {
    mockEnv.KG_AUTH_MODE = 'komplyt';
    const res = await app().request('/who');
    expect(res.status).toBe(401);
  });
});

describe('POST /mcp', () => {
  const tool: ToolHandler = {
    name: 'kg_query',
    description: 'q',
    inputSchema: z.object({}),
    responseSchema: z.unknown(),
    requiredScope: 'kg:read',
    annotations: { title: 'q', readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    execute: vi.fn().mockResolvedValue({ content: [{ type: 'text' as const, text: '{}' }] }),
  };
  const db = { query: vi.fn().mockResolvedValue([]), queryOne: vi.fn().mockResolvedValue(null), close: vi.fn() };

  function app() {
    const a = new Hono();
    a.route(
      '/mcp',
      createMcpRoutes({
        dbFactory: { createScoped: vi.fn().mockResolvedValue(db) },
        embed: { embedDocuments: vi.fn(), embedQuery: vi.fn(), model: 'x', dimensions: 1024 as const },
        toolRegistry: { list: () => [tool], get: (n: string) => (n === 'kg_query' ? tool : undefined) },
      })
    );
    return a;
  }

  const call = (headers: Record<string, string> = {}) =>
    app().request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  it('local mode: tools/list works without an Authorization header', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.tools.map((t: { name: string }) => t.name)).toContain('kg_query');
  });

  it('komplyt mode: the same request is a 401', async () => {
    mockEnv.KG_AUTH_MODE = 'komplyt';
    const res = await call();
    expect(res.status).toBe(401);
  });
});
