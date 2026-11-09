import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { describeIssues, describeFirstIssue } from './validation-message.js';
import { queryParamsSchema, metaModelParamsSchema } from './contracts.js';

const schema = z.strictObject({ text: z.string().optional(), limit: z.number().optional() });

function errorOf(s: z.ZodType, input: unknown): z.ZodError {
  const r = s.safeParse(input);
  if (r.success) throw new Error('expected a validation failure');
  return r.error;
}

describe('describeIssues', () => {
  it('names a single unknown key and lists the valid keys', () => {
    expect(describeIssues(errorOf(schema, { query: 'x' }), schema)).toBe(
      'Unrecognized key "query"; valid keys: text, limit',
    );
  });

  it('names several unknown keys with the plural form', () => {
    expect(describeIssues(errorOf(schema, { a: 1, b: 2 }), schema)).toBe(
      'Unrecognized keys "a", "b"; valid keys: text, limit',
    );
  });

  it('lists the keys of the real kg_query schema', () => {
    const message = describeIssues(errorOf(queryParamsSchema, { query: 'x' }), queryParamsSchema);
    expect(message).toContain('Unrecognized key "query"');
    expect(message).toContain('text');
    expect(message).toContain('read_only');
  });

  it('lists the keys of a schema that has a refine on it (kg_meta_model)', () => {
    const message = describeIssues(errorOf(metaModelParamsSchema, { scope: 'project', id: 'p', extra: 1 }), metaModelParamsSchema);
    expect(message).toContain('Unrecognized key "extra"');
    expect(message).toContain('valid keys: scope, id, lens');
  });

  it('omits the valid-keys list when the schema is not an object schema', () => {
    const union = z.union([schema, z.string()]);
    expect(describeIssues(errorOf(schema, { query: 'x' }), union)).toBe('Unrecognized key "query"');
    expect(describeIssues(errorOf(schema, { query: 'x' }))).toBe('Unrecognized key "query"');
  });

  it('keeps path: message for other issues and joins an unknown key with a type error', () => {
    const message = describeIssues(errorOf(schema, { limit: 'many', query: 'x' }), schema);
    expect(message).toContain('limit: ');
    expect(message).toContain('Unrecognized key "query"; valid keys: text, limit');
    expect(message).toContain('; ');
  });

  it('names the path of a nested unknown key and does not list the top-level keys for it', () => {
    const nested = z.strictObject({ inner: z.strictObject({ a: z.string() }), top: z.string().optional() });
    expect(describeIssues(errorOf(nested, { inner: { a: 'x', b: 1 } }), nested)).toBe('inner: Unrecognized key "b"');
  });

  it('prints a root-level issue without an empty path prefix', () => {
    expect(describeIssues(errorOf(z.string(), 5))).toMatch(/^Invalid input/);
  });
});

describe('describeFirstIssue', () => {
  it('describes only the first issue', () => {
    const message = describeFirstIssue(errorOf(schema, { limit: 'many', query: 'x' }), schema);
    expect(message).not.toContain('; ');
  });
});
