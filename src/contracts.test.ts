import { describe, it, expect } from 'vitest';
import {
  nodeCreateParamsSchema,
  queryParamsSchema,
  nodeUpdateParamsSchema,
  relateParamsSchema,
  sessionStartParamsSchema,
  sessionEndParamsSchema,
  sessionInfoParamsSchema,
  statusParamsSchema,
  metaModelParamsSchema,
} from './contracts.js';

describe('Tool parameter schemas', () => {
  describe('JSON Schema generation (Zod 4 native)', () => {
    const schemas = [
      { name: 'kg_node_create', schema: nodeCreateParamsSchema },
      { name: 'kg_query', schema: queryParamsSchema },
      { name: 'kg_node_update', schema: nodeUpdateParamsSchema },
      { name: 'kg_relate', schema: relateParamsSchema },
      { name: 'kg_session_start', schema: sessionStartParamsSchema },
      { name: 'kg_status', schema: statusParamsSchema },
      { name: 'kg_meta_model', schema: metaModelParamsSchema },
    ];

    it.each(schemas)('$name produces well-formed JSON schema', ({ schema }) => {
      const jsonSchema = schema.toJSONSchema({ unrepresentable: 'any' });

      // Must have type: object for MCP compatibility
      expect(jsonSchema).toHaveProperty('type', 'object');

      // Must have properties object
      expect(jsonSchema).toHaveProperty('properties');
      expect(typeof jsonSchema.properties).toBe('object');

      // Properties should not be empty
      expect(Object.keys(jsonSchema.properties as object).length).toBeGreaterThan(0);
    });

    it.each(schemas)('$name includes required array', ({ schema }) => {
      const jsonSchema = schema.toJSONSchema({ unrepresentable: 'any' });
      // Required may be empty for optional-only schemas, but should exist
      expect(Array.isArray(jsonSchema.required) || jsonSchema.required === undefined).toBe(true);
    });
  });

  describe('Coercible types - runtime behavior', () => {
    describe('coercibleBool', () => {
      it('accepts boolean true', () => {
        const result = queryParamsSchema.safeParse({ include_related: true });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.include_related).toBe(true);
        }
      });

      it('accepts boolean false', () => {
        const result = queryParamsSchema.safeParse({ include_related: false });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.include_related).toBe(false);
        }
      });

      it('coerces string "true" to boolean true', () => {
        const result = queryParamsSchema.safeParse({ include_related: 'true' });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.include_related).toBe(true);
        }
      });

      it('coerces string "false" to boolean false', () => {
        const result = queryParamsSchema.safeParse({ include_related: 'false' });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.include_related).toBe(false);
        }
      });
    });

    describe('coercibleInt', () => {
      it('accepts number', () => {
        const result = queryParamsSchema.safeParse({ limit: 25 });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.limit).toBe(25);
        }
      });

      it('coerces string to number', () => {
        const result = queryParamsSchema.safeParse({ limit: '25' });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.limit).toBe(25);
        }
      });
    });

    describe('coercibleFloat', () => {
      it('accepts number', () => {
        const result = queryParamsSchema.safeParse({ spread_factor: 0.75 });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.spread_factor).toBe(0.75);
        }
      });

      it('coerces string to float', () => {
        const result = queryParamsSchema.safeParse({ spread_factor: '0.75' });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.spread_factor).toBe(0.75);
        }
      });
    });

    describe('coercibleStringArray', () => {
      it('accepts array of strings', () => {
        const result = nodeCreateParamsSchema.safeParse({
          type: 'observation',
          content: 'test content',
          tags: ['tag1', 'tag2'],
        });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.tags).toEqual(['tag1', 'tag2']);
        }
      });

      it('coerces JSON string to array', () => {
        const result = nodeCreateParamsSchema.safeParse({
          type: 'observation',
          content: 'test content',
          tags: '["tag1", "tag2"]',
        });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.tags).toEqual(['tag1', 'tag2']);
        }
      });

      it('wraps plain string in array', () => {
        const result = nodeCreateParamsSchema.safeParse({
          type: 'observation',
          content: 'test content',
          tags: 'single-tag',
        });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.tags).toEqual(['single-tag']);
        }
      });
    });
  });

  describe('Schema validation', () => {
    describe('kg_node_create', () => {
      it('requires type and content', () => {
        const result = nodeCreateParamsSchema.safeParse({});
        expect(result.success).toBe(false);
      });

      it('accepts valid record params', () => {
        const result = nodeCreateParamsSchema.safeParse({
          type: 'decision',
          content: 'We decided to use Zod 4',
          status: 'open',
          tags: ['architecture'],
        });
        expect(result.success).toBe(true);
      });

      it('rejects invalid node type', () => {
        const result = nodeCreateParamsSchema.safeParse({
          type: 'invalid-type',
          content: 'test',
        });
        expect(result.success).toBe(false);
      });
    });

    describe('kg_query', () => {
      it('accepts empty params (all optional)', () => {
        const result = queryParamsSchema.safeParse({});
        expect(result.success).toBe(true);
      });

      it('applies defaults', () => {
        const result = queryParamsSchema.safeParse({});
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.limit).toBe(10);
          expect(result.data.include_related).toBe(false);
          expect(result.data.spread).toBe(true);
          expect(result.data.read_only).toBe(false);
        }
      });

      // read_only must default to false (existing clients keep
      // implicit activation) and coerce from the string forms REST query
      // strings and loosely-typed MCP clients send.
      it('read_only coerces string forms and defaults to false', () => {
        for (const [input, expected] of [
          [true, true],
          ['true', true],
          [false, false],
          ['false', false],
          [undefined, false],
        ] as const) {
          const result = queryParamsSchema.safeParse(input === undefined ? {} : { read_only: input });
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.data.read_only).toBe(expected);
          }
        }
      });
    });

    describe('kg_session_start / kg_session_end / kg_session_info', () => {
      it('start accepts empty object and project', () => {
        expect(sessionStartParamsSchema.safeParse({}).success).toBe(true);
        expect(sessionStartParamsSchema.safeParse({ project: 'my-project' }).success).toBe(true);
      });

      it('end and info accept empty object and expose no action parameter', () => {
        for (const schema of [sessionEndParamsSchema, sessionInfoParamsSchema]) {
          expect(schema.safeParse({}).success).toBe(true);
          expect(schema.toJSONSchema({ unrepresentable: 'any' })).toHaveProperty('type', 'object');
        }
      });
    });
  });
});

describe('Tool parameter schemas reject unknown keys', () => {
  // Minimal valid input per tool, so the only thing wrong in the second case is the extra key.
  const cases = [
    { name: 'kg_node_create', schema: nodeCreateParamsSchema, valid: { type: 'decision', content: 'x' } },
    { name: 'kg_node_update', schema: nodeUpdateParamsSchema, valid: { id: 'node:abc' } },
    { name: 'kg_query', schema: queryParamsSchema, valid: { text: 'x' } },
    { name: 'kg_relate', schema: relateParamsSchema, valid: { from: 'node:a', to: 'node:b' } },
    { name: 'kg_session_start', schema: sessionStartParamsSchema, valid: { project: 'p' } },
    { name: 'kg_session_end', schema: sessionEndParamsSchema, valid: {} },
    { name: 'kg_session_info', schema: sessionInfoParamsSchema, valid: {} },
    { name: 'kg_status', schema: statusParamsSchema, valid: { project: 'p' } },
    { name: 'kg_meta_model', schema: metaModelParamsSchema, valid: { scope: 'project', id: 'p' } },
  ];

  it.each(cases)('$name accepts valid input', ({ schema, valid }) => {
    expect(schema.safeParse(valid).success).toBe(true);
  });

  it.each(cases)('$name rejects an unknown key and names it', ({ schema, valid }) => {
    const result = schema.safeParse({ ...valid, not_a_parameter: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({ code: 'unrecognized_keys', keys: ['not_a_parameter'] });
    }
  });

  it.each(cases)('$name publishes additionalProperties: false in its JSON Schema', ({ schema }) => {
    expect(schema.toJSONSchema({ unrepresentable: 'any' })).toHaveProperty('additionalProperties', false);
  });

  it('still applies the kg_meta_model refine on a strict schema', () => {
    expect(metaModelParamsSchema.safeParse({ scope: 'project' }).success).toBe(false);
  });

  it('still coerces string booleans and numbers on kg_query', () => {
    const result = queryParamsSchema.safeParse({ text: 'x', read_only: 'true', limit: '5' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ read_only: true, limit: 5 });
  });
});
