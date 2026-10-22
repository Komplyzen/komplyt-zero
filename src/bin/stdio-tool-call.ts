/**
 * The stdio MCP server's tools/call handling, extracted from bin/mcp.ts so it
 * can be unit-tested without the stdio transport, keytar, or the log
 * redirection that bin/mcp.ts performs on import.
 *
 * Mirrors the HTTP transport (mcp.ts tools/call): tool lookup, scope check,
 * Zod validation at the boundary, execute with already-validated params.
 * Validation was missing here until recently; raw arguments reached execute()
 * and every schema default was silently dropped on stdio.
 */

import { requireScope, AuthError } from '../auth.js';
import { getLegacyTool } from '../tools/legacy.js';
import type {
  DbFactory,
  EmbeddingProvider,
  KgDbClient,
  KgTokenPayload,
  ToolContext,
  ToolHandler,
  ToolName,
} from '../contracts.js';

export interface StdioToolCallDeps {
  registry: { get(name: ToolName): ToolHandler<unknown> | undefined };
  db: KgDbClient;
  embed: EmbeddingProvider;
  claims: KgTokenPayload;
}

export interface StdioToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  /** Session id the caller should carry into the next call (unchanged unless kg_session_start/kg_session_end started/ended one). */
  sessionId: string | null;
}

export function errorResult(text: string, sessionId: string | null): StdioToolCallResult {
  return { content: [{ type: 'text', text }], isError: true, sessionId };
}

/**
 * The errors that need neither the database nor the caller's claims: an unknown tool and invalid
 * arguments. Checked before the server waits for its startup. Null when the call may proceed.
 */
export function rejectBeforeStartup(
  registry: StdioToolCallDeps['registry'],
  name: string,
  args: unknown,
  currentSession: string | null
): StdioToolCallResult | null {
  const tool = registry.get(name as ToolName) ?? getLegacyTool(name);
  if (!tool) return errorResult(`Unknown tool: ${name}`, currentSession);
  const parsed = tool.inputSchema.safeParse(args ?? {});
  if (parsed.success) return null;
  return errorResult(`Invalid params: ${issueSummary(parsed.error)}`, currentSession);
}

function issueSummary(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ');
}

export async function executeStdioToolCall(
  deps: StdioToolCallDeps,
  name: string,
  args: unknown,
  currentSession: string | null
): Promise<StdioToolCallResult> {
  const tool = deps.registry.get(name as ToolName) ?? getLegacyTool(name);
  if (!tool) {
    return errorResult(`Unknown tool: ${name}`, currentSession);
  }

  try {
    requireScope(tool.requiredScope, deps.claims);
  } catch (err) {
    if (err instanceof AuthError) {
      return errorResult(err.message, currentSession);
    }
    throw err;
  }

  const parsed = tool.inputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return errorResult(`Invalid params: ${issueSummary(parsed.error)}`, currentSession);
  }

  const ctx: ToolContext = {
    claims: deps.claims,
    tenantId: deps.claims.tenantId,
    projects: deps.claims.projects,
    scope: deps.claims.scope,
    currentSession,
  };

  const result = await tool.execute(deps.db, deps.embed, ctx, parsed.data);

  let sessionId = currentSession;
  if ((name === 'kg_session_start' || name === 'kg_session_end' || name === 'kg_session') && !result.isError) {
    try {
      const data = JSON.parse(result.content[0].text);
      if (data.action === 'started') sessionId = data.session_id;
      else if (data.action === 'ended') sessionId = null;
    } catch {
      /* ignore: a session result that is not JSON leaves the session untouched */
    }
  }

  return {
    content: result.content.map((c) => ({ type: 'text' as const, text: c.text })),
    isError: result.isError,
    sessionId,
  };
}

export interface StdioScopedToolCallDeps {
  registry: StdioToolCallDeps['registry'];
  dbFactory: DbFactory;
  embed: EmbeddingProvider;
  claims: KgTokenPayload;
}

/**
 * executeStdioToolCall on a connection signed in for this call only.
 *
 * The stdio server is a long-lived process, but a scoped DB session is not
 * meant to be: its kg_auth_session row is pruned after a retention window,
 * and a connection held past that sees empty results with no error. Signing
 * in per call (as the HTTP transport does) keeps every call inside the window.
 */
export async function executeStdioToolCallScoped(
  deps: StdioScopedToolCallDeps,
  name: string,
  args: unknown,
  currentSession: string | null
): Promise<StdioToolCallResult> {
  const db = await deps.dbFactory.createScoped(deps.claims);
  try {
    return await executeStdioToolCall(
      { registry: deps.registry, db, embed: deps.embed, claims: deps.claims },
      name,
      args,
      currentSession
    );
  } finally {
    await db.close();
  }
}
