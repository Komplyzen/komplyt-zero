import { describe, it, expect } from 'vitest';
import { toolRegistry } from './index.js';
import { requireScope, AuthError } from '../auth.js';
import type { KgTokenPayload } from '../contracts.js';

describe('tool registry (OpenAI review rule L17: no dynamic action-dispatch tools)', () => {
  const names = toolRegistry.list().map((t) => t.name);

  it('exposes one tool per operation and none of the removed names', () => {
    expect(names).toContain('kg_node_create');
    expect(names).toContain('kg_node_update');
    for (const removed of ['kg_node', 'kg_record', 'kg_update']) {
      expect(names).not.toContain(removed as never);
    }
    expect(names).toContain('kg_session_start');
    expect(names).toContain('kg_session_end');
    expect(names).toContain('kg_session_info');
    expect(names).toContain('kg_status');
    expect(names).not.toContain('kg_session' as never);
  });

  it('has unique tool names', () => {
    expect(new Set(names).size).toBe(names.length);
  });

  it('no tool takes an action/operation dispatch parameter', () => {
    for (const tool of toolRegistry.list()) {
      const json = tool.inputSchema.toJSONSchema({ unrepresentable: 'any' });
      const props = Object.keys((json.properties ?? {}) as object);
      expect(props, tool.name).not.toContain('action');
      expect(props, tool.name).not.toContain('operation');
    }
  });

  it('annotations match behavior: info/status read-only, start/end write', () => {
    const ro = (n: 'kg_session_info' | 'kg_status' | 'kg_session_start' | 'kg_session_end') =>
      toolRegistry.get(n)!.annotations.readOnlyHint;
    expect(ro('kg_session_info')).toBe(true);
    expect(ro('kg_status')).toBe(true);
    expect(ro('kg_session_start')).toBe(false);
    expect(ro('kg_session_end')).toBe(false);
    expect(toolRegistry.get('kg_session_info')!.requiredScope).toBe('kg:read');
    // start decays and query reactivates usage metrics (decay_score), never node content
    expect(toolRegistry.get('kg_session_start')!.annotations.destructiveHint).toBe(false);
    expect(toolRegistry.get('kg_query')!.annotations.readOnlyHint).toBe(false);
    expect(toolRegistry.get('kg_query')!.annotations.destructiveHint).toBe(false);
    expect(toolRegistry.get('kg_relate')!.annotations.idempotentHint).toBe(false);
  });

  it('a read-only token can call exactly the read-only tools', () => {
    const readOnly: KgTokenPayload = { sub: 'u', tenantId: 't', projects: [], scope: 'kg:read', principals: [], tier: 'free' };
    const callable = toolRegistry
      .list()
      .filter((t) => {
        try {
          requireScope(t.requiredScope, readOnly);
          return true;
        } catch (e) {
          if (e instanceof AuthError) return false;
          throw e;
        }
      })
      .map((t) => t.name)
      .sort();
    expect(callable).toEqual(['kg_meta_model', 'kg_query', 'kg_session_info', 'kg_status']);
  });
});
