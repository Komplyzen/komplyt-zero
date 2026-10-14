import { z } from 'zod';
import {
  ToolHandler,
  ToolAnnotations,
  ToolContext,
  ToolResult,
  KgDbClient,
  EmbeddingProvider,
  toolError,
} from '../contracts.js';
import { childLogger } from '../logger.js';
import { nodeCreateTool } from './node-create.js';
import { nodeUpdateTool } from './node-update.js';
import { sessionStartTool } from './session-start.js';
import { sessionEndTool } from './session-end.js';
import { sessionInfoTool } from './session-info.js';
import { statusTool } from './status.js';

const logger = childLogger('legacy-tools');

/**
 * TEMPORARY compatibility for the one-tool-per-operation split (OpenAI L17).
 *
 * ChatGPT keeps offering the OLD tool names from its last approved scan until
 * OpenAI re-reviews the new ones. These aliases keep those calls working during
 * that window. They are deliberately NOT in the registry (so never in
 * tools/list): the scan must see the old tools as deleted. They switch
 * themselves off on LEGACY_TOOLS_UNTIL; delete this file after that date.
 */
export const LEGACY_TOOLS_UNTIL = new Date('2026-11-06T00:00:00Z');

/** Like ToolHandler, but with a name outside the public ToolName union. */
export type LegacyToolHandler = Omit<ToolHandler<unknown>, 'name'> & { name: string };

const annotations: ToolAnnotations = {
  title: 'Deprecated tool name',
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: true,
  idempotentHint: false,
};

// Old callers sent loose objects (the old schemas had cross-field refinements);
// the NEW tool's schema does the real validation after dispatch.
const looseSchema = z.object({ action: z.string().optional() }).passthrough();

type Target = ToolHandler;

function alias(
  name: string,
  pick: (params: Record<string, unknown>, ctx: ToolContext) => Target | string
): LegacyToolHandler {
  return {
    name,
    description: `Deprecated alias of the per-operation tools (removed after ${LEGACY_TOOLS_UNTIL.toISOString().slice(0, 10)}).`,
    inputSchema: looseSchema as z.ZodType<unknown>,
    responseSchema: z.unknown(),
    requiredScope: 'kg:write',
    annotations,

    async execute(
      db: KgDbClient,
      embed: EmbeddingProvider,
      ctx: ToolContext,
      rawParams: unknown
    ): Promise<ToolResult> {
      const params = rawParams as Record<string, unknown>; // validated by looseSchema
      const target = pick(params, ctx);
      if (typeof target === 'string') {
        return toolError('INVALID_INPUT', target);
      }
      logger.warn({ legacyTool: name, replacement: target.name, sub: ctx.claims.sub }, 'Deprecated tool name called');

      const rest = { ...params };
      delete rest.action;
      const parsed = target.inputSchema.safeParse(rest);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return toolError('INVALID_INPUT', `Use ${target.name}. Invalid params: ${issues}`);
      }
      return target.execute(db, embed, ctx, parsed.data);
    },
  };
}

const legacyTools: LegacyToolHandler[] = [
  alias('kg_session', (params, ctx) => {
    // Old behavior: no action -> start if no session, status if one is active.
    const action = (params.action as string | undefined) ?? (ctx.currentSession ? 'status' : 'start');
    switch (action) {
      case 'start': return sessionStartTool;
      case 'end': return sessionEndTool;
      case 'info': return sessionInfoTool;
      case 'status': return statusTool;
      default: return `Unknown action '${action}'. Use kg_session_start, kg_session_end, kg_session_info or kg_status.`;
    }
  }),
  alias('kg_node', (params) => {
    const action = (params.action as string | undefined) ?? 'create';
    if (action === 'create') return nodeCreateTool;
    if (action === 'update') return nodeUpdateTool;
    return `Unknown action '${action}'. Use kg_node_create or kg_node_update.`;
  }),
  alias('kg_record', () => nodeCreateTool),
  alias('kg_update', () => nodeUpdateTool),
];

/** The old-name handler for `name`, or undefined (unknown name, or the window has closed). */
export function getLegacyTool(name: string, now: Date = new Date()): LegacyToolHandler | undefined {
  if (now >= LEGACY_TOOLS_UNTIL) return undefined;
  return legacyTools.find((t) => t.name === name);
}
