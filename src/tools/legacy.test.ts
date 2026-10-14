import { describe, it, expect, vi, afterEach } from 'vitest';
import type { KgDbClient, EmbeddingProvider, ToolContext } from '../contracts.js';
import { toolSuccess } from '../contracts.js';
import { toolRegistry, sessionStartTool, sessionEndTool, sessionInfoTool, statusTool, nodeCreateTool, nodeUpdateTool } from './index.js';
import { getLegacyTool, LEGACY_TOOLS_UNTIL } from './legacy.js';

const db = {} as KgDbClient;
const embed = {} as EmbeddingProvider;
const ctxWith = (currentSession: string | null): ToolContext => ({
  claims: { sub: 'u', tenantId: 't', projects: [], scope: 'kg:read kg:write', principals: [], tier: 'free' },
  tenantId: 't',
  projects: [],
  scope: 'kg:read kg:write',
  currentSession,
});

afterEach(() => vi.restoreAllMocks());

// These tests check ROUTING only (which new tool an old name reaches, and with
// what arguments); the new tools themselves are covered against a real database
// in the integration suites.
function spyAll() {
  const spies = {
    start: vi.spyOn(sessionStartTool, 'execute').mockResolvedValue(toolSuccess({ via: 'start' })),
    end: vi.spyOn(sessionEndTool, 'execute').mockResolvedValue(toolSuccess({ via: 'end' })),
    info: vi.spyOn(sessionInfoTool, 'execute').mockResolvedValue(toolSuccess({ via: 'info' })),
    status: vi.spyOn(statusTool, 'execute').mockResolvedValue(toolSuccess({ via: 'status' })),
    create: vi.spyOn(nodeCreateTool, 'execute').mockResolvedValue(toolSuccess({ via: 'create' })),
    update: vi.spyOn(nodeUpdateTool, 'execute').mockResolvedValue(toolSuccess({ via: 'update' })),
  };
  return spies;
}

const call = (name: string, params: Record<string, unknown>, session: string | null = null) =>
  getLegacyTool(name)!.execute(db, embed, ctxWith(session), params);

describe('legacy tool aliases (temporary, OpenAI L17 transition)', () => {
  it('are not in the registry, so never listed', () => {
    const listed = toolRegistry.list().map((t) => t.name as string);
    for (const old of ['kg_session', 'kg_node', 'kg_record', 'kg_update']) {
      expect(listed).not.toContain(old);
      expect(getLegacyTool(old)).toBeDefined();
    }
  });

  it('kg_session routes by action and strips it', async () => {
    const s = spyAll();
    await call('kg_session', { action: 'start', project: 'p', create_project: true });
    await call('kg_session', { action: 'end' });
    await call('kg_session', { action: 'info' });
    await call('kg_session', { action: 'status', project: 'p' });
    expect(s.start).toHaveBeenCalledWith(db, embed, expect.anything(), { project: 'p', create_project: true });
    expect(s.end).toHaveBeenCalledOnce();
    expect(s.info).toHaveBeenCalledOnce();
    expect(s.status).toHaveBeenCalledWith(db, embed, expect.anything(), { project: 'p' });
  });

  it('kg_session without action starts when no session is active, else reports status', async () => {
    const s = spyAll();
    await call('kg_session', {}, null);
    await call('kg_session', {}, 'session:abc');
    expect(s.start).toHaveBeenCalledOnce();
    expect(s.status).toHaveBeenCalledOnce();
  });

  it('kg_node defaults to create and routes update', async () => {
    const s = spyAll();
    await call('kg_node', { type: 'decision', content: 'x' }, 'session:abc');
    await call('kg_node', { action: 'create', type: 'decision', content: 'y' }, 'session:abc');
    await call('kg_node', { action: 'update', id: 'node:1', status: 'done' }, 'session:abc');
    expect(s.create).toHaveBeenCalledTimes(2);
    expect(s.update).toHaveBeenCalledWith(db, embed, expect.anything(), { id: 'node:1', status: 'done' });
  });

  it('kg_record creates and kg_update updates', async () => {
    const s = spyAll();
    await call('kg_record', { type: 'observation', content: 'c' }, 'session:abc');
    await call('kg_update', { id: 'node:1', content: 'new' }, 'session:abc');
    expect(s.create).toHaveBeenCalledOnce();
    expect(s.update).toHaveBeenCalledOnce();
  });

  it('returns actionable errors for unknown actions and for params the new schema rejects', async () => {
    const s = spyAll();
    const badAction = await call('kg_session', { action: 'explode' });
    expect(badAction.isError).toBe(true);
    expect(badAction.content[0].text).toContain('kg_session_start');

    const badParams = await call('kg_node', { action: 'update' }, 'session:abc');
    expect(badParams.isError).toBe(true);
    expect(badParams.content[0].text).toContain('kg_node_update');
    expect(s.update).not.toHaveBeenCalled();
  });

  it('switch themselves off on the removal date', () => {
    expect(getLegacyTool('kg_session', new Date(LEGACY_TOOLS_UNTIL.getTime() - 1))).toBeDefined();
    expect(getLegacyTool('kg_session', LEGACY_TOOLS_UNTIL)).toBeUndefined();
  });
});
