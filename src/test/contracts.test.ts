import { describe, it, expect } from 'vitest';
import {
  CONTRACT_VERSION,
  NodeType,
  Status,
  hasScope,
  toolSuccess,
  toolError,
  ERROR_HTTP_STATUS,
  TOOL_SCOPES,
  ACTIVATION,
  nodeCreateParamsSchema,
  queryParamsSchema,
  nodeUpdateParamsSchema,
  relateParamsSchema,
  sessionStartParamsSchema,
  sessionEndParamsSchema,
  sessionInfoParamsSchema,
  statusParamsSchema,
} from '../contracts.js';

describe('contracts', () => {
  describe('CONTRACT_VERSION', () => {
    it('should be a valid semver string', () => {
      expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe('hasScope', () => {
    it('should return true when scope includes required scope', () => {
      expect(hasScope('kg:read kg:write', 'kg:read')).toBe(true);
      expect(hasScope('kg:read kg:write', 'kg:write')).toBe(true);
    });

    it('should return false when scope does not include required scope', () => {
      expect(hasScope('kg:read', 'kg:write')).toBe(false);
    });
  });

  describe('toolSuccess', () => {
    it('should create a success result with JSON stringified data', () => {
      const result = toolSuccess({ id: 'node:123' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual({ id: 'node:123' });
    });
  });

  describe('toolError', () => {
    it('should create an error result with error code', () => {
      const result = toolError('NOT_FOUND', 'Node not found');
      expect(result.isError).toBe(true);
      expect(result.errorCode).toBe('NOT_FOUND');
      expect(result.content[0].text).toBe('Node not found');
    });
  });

  describe('ERROR_HTTP_STATUS', () => {
    it('should map all error codes to HTTP status codes', () => {
      expect(ERROR_HTTP_STATUS.INVALID_INPUT).toBe(400);
      expect(ERROR_HTTP_STATUS.NOT_FOUND).toBe(404);
      expect(ERROR_HTTP_STATUS.SCOPE_DENIED).toBe(403);
      expect(ERROR_HTTP_STATUS.NO_SESSION).toBe(400);
      expect(ERROR_HTTP_STATUS.INTERNAL).toBe(500);
    });
  });

  describe('TOOL_SCOPES', () => {
    it('should define scopes for all 9 tools', () => {
      // Primary tools
      expect(TOOL_SCOPES.kg_node_create).toBe('kg:write');
      expect(TOOL_SCOPES.kg_node_update).toBe('kg:write');
      expect(TOOL_SCOPES.kg_query).toBe('kg:read');
      expect(TOOL_SCOPES.kg_relate).toBe('kg:write');
      expect(TOOL_SCOPES.kg_session_start).toBe('kg:write');
      expect(TOOL_SCOPES.kg_session_end).toBe('kg:write');
      expect(TOOL_SCOPES.kg_session_info).toBe('kg:read');
      expect(TOOL_SCOPES.kg_meta_model).toBe('kg:read');
      expect(TOOL_SCOPES.kg_status).toBe('kg:read');
    });
  });

  describe('ACTIVATION constants', () => {
    it('should match Rust implementation values', () => {
      expect(ACTIVATION.CEILING).toBe(0.85);
      expect(ACTIVATION.BASE_FACTOR).toBe(0.15);
      expect(ACTIVATION.MAX_FACTOR).toBe(0.40);
      expect(ACTIVATION.VACUUM_THRESHOLD).toBe(0.0001);
      expect(ACTIVATION.IMPLICIT_FACTOR).toBe(0.05);
      expect(ACTIVATION.DEFAULT_DECAY_RATE).toBe(0.85);
      expect(ACTIVATION.DEFAULT_EDGE_DECAY_RATE).toBe(0.95);
      expect(ACTIVATION.MIN_EDGE_WEIGHT).toBe(0.05);
    });
  });
});

describe('Zod schemas', () => {
  describe('NodeType', () => {
    it('should accept all valid node types', () => {
      const types = ['observation', 'decision', 'argument', 'todo', 'problem', 'mitigation', 'workaround', 'approach'];
      for (const type of types) {
        expect(NodeType.parse(type)).toBe(type);
      }
    });

    it('should reject invalid node types', () => {
      expect(() => NodeType.parse('invalid')).toThrow();
    });
  });

  describe('Status', () => {
    it('should accept all valid statuses', () => {
      const statuses = ['open', 'resolved', 'blocked', 'done'];
      for (const status of statuses) {
        expect(Status.parse(status)).toBe(status);
      }
    });
  });

  describe('nodeCreateParamsSchema', () => {
    it('should accept valid record params', () => {
      const params = {
        type: 'decision',
        content: 'Use TypeScript for rewrite',
        status: 'open',
        tags: ['tech', 'architecture'],
      };
      expect(nodeCreateParamsSchema.parse(params)).toMatchObject(params);
    });

    it('should reject empty content', () => {
      expect(() => nodeCreateParamsSchema.parse({ type: 'observation', content: '' })).toThrow();
    });

    it('should reject whitespace-only content', () => {
      expect(() => nodeCreateParamsSchema.parse({ type: 'observation', content: '   ' })).toThrow();
    });
  });

  describe('queryParamsSchema', () => {
    it('should apply defaults', () => {
      const result = queryParamsSchema.parse({});
      expect(result.include_related).toBe(false);
      expect(result.spread).toBe(true);
      expect(result.spread_hops).toBe(2);
      expect(result.spread_factor).toBe(0.5);
      expect(result.activation_threshold).toBe(0.1);
      expect(result.limit).toBe(10);
    });

    it('should clamp spread_hops to 1-3', () => {
      expect(() => queryParamsSchema.parse({ spread_hops: 0 })).toThrow();
      expect(() => queryParamsSchema.parse({ spread_hops: 4 })).toThrow();
      expect(queryParamsSchema.parse({ spread_hops: 3 }).spread_hops).toBe(3);
    });
  });

  describe('nodeUpdateParamsSchema', () => {
    it('should require id', () => {
      expect(() => nodeUpdateParamsSchema.parse({})).toThrow();
      expect(nodeUpdateParamsSchema.parse({ id: 'node:123' }).id).toBe('node:123');
    });
  });

  describe('relateParamsSchema', () => {
    it('should require from and to', () => {
      expect(() => relateParamsSchema.parse({ from: 'node:1' })).toThrow();
      expect(() => relateParamsSchema.parse({ to: 'node:2' })).toThrow();
      expect(relateParamsSchema.parse({ from: 'node:1', to: 'node:2' })).toEqual({
        from: 'node:1',
        to: 'node:2',
      });
    });
  });

  describe('sessionStartParamsSchema', () => {
    it('should accept empty object and default create_project to false', () => {
      const result = sessionStartParamsSchema.parse({});
      expect(result.create_project).toBe(false);
    });

    it('should accept project, create_project and notes', () => {
      const result = sessionStartParamsSchema.parse({ project: 'p', create_project: true, notes: 'n' });
      expect(result).toEqual({ project: 'p', create_project: true, notes: 'n' });
    });

    it('should not expose an action parameter (OpenAI L17)', () => {
      expect(Object.keys(sessionStartParamsSchema.shape)).not.toContain('action');
    });
  });

  describe('sessionEndParamsSchema / sessionInfoParamsSchema', () => {
    it('should accept empty object', () => {
      expect(sessionEndParamsSchema.parse({})).toEqual({});
      expect(sessionInfoParamsSchema.parse({})).toEqual({});
    });
  });

  describe('statusParamsSchema', () => {
    it('should accept empty object', () => {
      expect(statusParamsSchema.parse({})).toEqual({});
    });

    it('should accept project filter', () => {
      expect(statusParamsSchema.parse({ project: 'kg-mcp-server' })).toEqual({
        project: 'kg-mcp-server',
      });
    });
  });
});
