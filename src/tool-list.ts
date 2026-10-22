import type { z } from 'zod';
import type { ToolRegistry } from './contracts.js';
import { childLogger } from './logger.js';

const logger = childLogger('tool-list');

const schemaCache = new Map<string, object>();

function toolJsonSchema(tool: { name: string; inputSchema: z.ZodType }): object {
  let cached = schemaCache.get(tool.name);
  if (!cached) {
    try {
      // unrepresentable: 'any' handles transforms by outputting {} (matches anything)
      const rawSchema = tool.inputSchema.toJSONSchema({ unrepresentable: 'any' });
      // MCP embeds these schemas, so the $schema meta reference is dropped
      const schema: Record<string, unknown> = { ...rawSchema };
      delete schema.$schema;
      cached = schema;
    } catch (err) {
      logger.warn({ tool: tool.name, err }, 'Failed to generate JSON schema, using fallback');
      cached = { type: 'object', properties: {}, additionalProperties: true };
    }
    schemaCache.set(tool.name, cached);
  }
  return cached;
}

/** The `tools/list` entries, shared by the HTTP and stdio transports. */
export function listToolEntries(registry: ToolRegistry) {
  return registry.list().map((t) => ({
    name: t.name,
    title: t.annotations?.title,
    description: t.description,
    inputSchema: toolJsonSchema(t),
    annotations: t.annotations,
  }));
}
