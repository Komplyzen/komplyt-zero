/**
 * Unit tests for the stdio tools/call path.
 *
 * The stdio server used to hand raw JSON-RPC arguments to tool.execute,
 * skipping Zod entirely, so schema defaults never applied over stdio. These
 * tests pin the boundary: defaults applied, strings coerced, invalid params
 * rejected as an isError tool result, scope enforced, session id tracked.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../env.js', () => ({
  env: {
    KG_DB_URL: 'ws://localhost:8000',
    KG_DB_USER: 'root',
    KG_DB_PASS: 'root',
    KG_DB_NS: 'kg',
    KG_DB_NAME: 'test',
    KG_JWT_SECRET: 'test-secret-that-is-at-least-32-characters',
    COHERE_API_KEY: 'test-key',
    LOG_LEVEL: 'error',
  },
  getEnv: () => ({}),
}));

import { executeStdioToolCall, type StdioToolCallDeps } from './stdio-tool-call.js';
import { queryParamsSchema, type KgTokenPayload, type ToolHandler, type ToolResult } from '../contracts.js';

const claims: KgTokenPayload = {
  sub: 'user_1',
  tenantId: 'tenant_1',
  scope: 'kg:read',
  principals: ['principal:user_user_1'],
  projects: [],
  tier: 'free',
};

function fakeTool(
  name: string,
  overrides: Partial<ToolHandler<unknown>> & { onExecute?: (params: unknown, session: string | null) => ToolResult }
): ToolHandler<unknown> {
  const { onExecute, ...rest } = overrides;
  return {
    name: name as ToolHandler['name'],
    description: 'fake',
    inputSchema: queryParamsSchema as z.ZodType<unknown>,
    responseSchema: z.unknown(),
    requiredScope: 'kg:read',
    annotations: { title: name, readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    async execute(_db, _embed, ctx, params) {
      return onExecute
        ? onExecute(params, ctx.currentSession)
        : { content: [{ type: 'text', text: JSON.stringify({ params }) }] };
    },
    ...rest,
  };
}

function depsWith(tools: ToolHandler<unknown>[], scope = 'kg:read'): StdioToolCallDeps {
  const map = new Map(tools.map((t) => [t.name, t]));
  return {
    registry: { get: (n) => map.get(n) },
    db: {} as StdioToolCallDeps['db'],
    embed: {} as StdioToolCallDeps['embed'],
    claims: { ...claims, scope },
  };
}

describe('executeStdioToolCall', () => {
  it('applies schema defaults before execute (spread=true, read_only=false when omitted)', async () => {
    let seen: unknown;
    const deps = depsWith([fakeTool('kg_query', { onExecute: (p) => { seen = p; return { content: [{ type: 'text', text: '{}' }] }; } })]);

    const res = await executeStdioToolCall(deps, 'kg_query', { text: 'x' }, null);

    expect(res.isError).toBeFalsy();
    expect(seen).toMatchObject({ text: 'x', spread: true, read_only: false, limit: 10 });
  });

  it('coerces read_only from the string "true"', async () => {
    let seen: unknown;
    const deps = depsWith([fakeTool('kg_query', { onExecute: (p) => { seen = p; return { content: [{ type: 'text', text: '{}' }] }; } })]);

    await executeStdioToolCall(deps, 'kg_query', { read_only: 'true' }, null);

    expect(seen).toMatchObject({ read_only: true });
  });

  it('rejects invalid params as an isError tool result naming the field, without calling execute', async () => {
    const onExecute = vi.fn();
    const deps = depsWith([fakeTool('kg_query', { onExecute })]);

    const res = await executeStdioToolCall(deps, 'kg_query', { limit: 'ten' }, null);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/^Invalid params: limit/);
    expect(onExecute).not.toHaveBeenCalled();
  });

  it('treats missing arguments as an empty object', async () => {
    let seen: unknown;
    const deps = depsWith([fakeTool('kg_query', { onExecute: (p) => { seen = p; return { content: [{ type: 'text', text: '{}' }] }; } })]);

    const res = await executeStdioToolCall(deps, 'kg_query', undefined, null);

    expect(res.isError).toBeFalsy();
    expect(seen).toMatchObject({ spread: true });
  });

  it('returns an error for an unknown tool', async () => {
    const res = await executeStdioToolCall(depsWith([]), 'kg_nope', {}, 'session:s1');
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('Unknown tool: kg_nope');
    expect(res.sessionId).toBe('session:s1');
  });

  it('enforces the tool scope before validation', async () => {
    const onExecute = vi.fn();
    const deps = depsWith([fakeTool('kg_query', { requiredScope: 'kg:write', onExecute })], 'kg:read');

    const res = await executeStdioToolCall(deps, 'kg_query', {}, null);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("Scope 'kg:write' required");
    expect(onExecute).not.toHaveBeenCalled();
  });

  it('passes the current session through and tracks kg_session_start/kg_session_end', async () => {
    let seenSession: string | null | undefined;
    const startTool = fakeTool('kg_session_start', {
      onExecute: (_p, s) => {
        seenSession = s;
        return { content: [{ type: 'text', text: JSON.stringify({ action: 'started', session_id: 'session:new' }) }] };
      },
    });
    const endTool = fakeTool('kg_session_end', {
      onExecute: (_p, s) => {
        seenSession = s;
        return { content: [{ type: 'text', text: JSON.stringify({ action: 'ended' }) }] };
      },
    });
    const deps = depsWith([startTool, endTool]);

    const started = await executeStdioToolCall(deps, 'kg_session_start', {}, null);
    expect(seenSession).toBeNull();
    expect(started.sessionId).toBe('session:new');

    const ended = await executeStdioToolCall(deps, 'kg_session_end', {}, started.sessionId);
    expect(seenSession).toBe('session:new');
    expect(ended.sessionId).toBeNull();
  });

  it('leaves the session untouched when a kg_session_end call errors', async () => {
    const endTool = fakeTool('kg_session_end', {
      onExecute: () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }),
    });
    const res = await executeStdioToolCall(depsWith([endTool]), 'kg_session_end', {}, 'session:keep');
    expect(res.isError).toBe(true);
    expect(res.sessionId).toBe('session:keep');
  });

  it('does not change the session for read-only kg_session_info', async () => {
    const infoTool = fakeTool('kg_session_info', {
      onExecute: () => ({ content: [{ type: 'text', text: JSON.stringify({ action: 'ended' }) }] }),
    });
    const res = await executeStdioToolCall(depsWith([infoTool]), 'kg_session_info', {}, 'session:keep');
    expect(res.sessionId).toBe('session:keep');
  });
});
