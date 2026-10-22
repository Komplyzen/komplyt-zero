import { describe, it, expect } from 'vitest';
import { toolRegistry } from './tools/index.js';
import { listToolEntries } from './tool-list.js';

type JsonSchema = { type?: string; properties?: Record<string, { description?: string }> };

describe('listToolEntries', () => {
  const entries = listToolEntries(toolRegistry);

  it('lists every registered tool', () => {
    expect(entries.map((e) => e.name)).toEqual(toolRegistry.list().map((t) => t.name));
  });

  it.each(entries.map((e) => [e.name, e] as const))('%s: has title, annotations and a JSON Schema', (_name, entry) => {
    const schema = entry.inputSchema as JsonSchema;
    expect(entry.title).toBe(entry.annotations?.title);
    expect(entry.title).toBeTruthy();
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
    // Zod internals (`_def`, `def`, `~standard`) would mean the schema was serialised, not converted.
    expect(JSON.stringify(entry.inputSchema)).not.toMatch(/"_def"|"~standard"|"def":/);
  });

  it.each(entries.map((e) => [e.name, e] as const))('%s: every property is described', (_name, entry) => {
    const { properties = {} } = entry.inputSchema as JsonSchema;
    const undocumented = Object.entries(properties).filter(([, p]) => !p.description).map(([k]) => k);
    expect(undocumented).toEqual([]);
  });

  it('survives a JSON round trip unchanged', () => {
    expect(JSON.parse(JSON.stringify(entries))).toEqual(JSON.parse(JSON.stringify(listToolEntries(toolRegistry))));
  });
});
