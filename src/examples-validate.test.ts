/**
 * The documentation shows tool calls as JSON. Parameter schemas reject unknown keys, so an example
 * with a misspelled or removed parameter would teach readers a call that fails. Every fenced tool
 * call in the examples and the README must validate against its tool's schema.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toolRegistry } from './tools/index.js';
import { describeIssues } from './validation-message.js';

const FILES = ['examples/sessions.md', 'README.md'];

/** Top-level `{...}` values in a code block (one per call; a call may span several lines). */
function jsonObjects(block: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) found.push(block.slice(start, i + 1));
    }
  }
  return found;
}

function toolCalls(file: string): Array<{ tool: string; arguments: unknown }> {
  const text = readFileSync(join(__dirname, '..', file), 'utf8');
  const calls: Array<{ tool: string; arguments: unknown }> = [];
  for (const [, block] of text.matchAll(/```json\n([\s\S]*?)```/g)) {
    for (const raw of jsonObjects(block)) {
      const value = JSON.parse(raw) as { tool?: unknown; arguments?: unknown };
      if (typeof value.tool === 'string' && 'arguments' in value) {
        calls.push({ tool: value.tool, arguments: value.arguments });
      }
    }
  }
  return calls;
}

describe('documented tool calls', () => {
  it.each(FILES)('%s contains tool calls (the check cannot pass by finding none)', (file) => {
    expect(toolCalls(file).length).toBeGreaterThan(0);
  });

  describe.each(FILES)('%s', (file) => {
    it.each(toolCalls(file).map((call, i) => [`${i + 1}: ${call.tool}`, call] as const))('call %s validates', (_label, call) => {
      const tool = toolRegistry.get(call.tool as never);
      expect(tool, `unknown tool ${call.tool}`).toBeDefined();
      const parsed = tool!.inputSchema.safeParse(call.arguments);
      expect(parsed.success, parsed.success ? '' : describeIssues(parsed.error, tool!.inputSchema)).toBe(true);
    });
  });
});
