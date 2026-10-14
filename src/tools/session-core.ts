import { KgDbClient, SessionRecord } from '../contracts.js';

/**
 * Resolve the tenant's active session. "Active" is purely
 * `ended_at IS NONE` - sessions have no separate status enum. This is the
 * one canonical definition; mcp.ts and tools/status.ts both import this
 * (rather than each running their own query) so they can't drift out of
 * sync with each other again. The original bug: four independent ad-hoc
 * "current session" queries existed (mcp.ts, status.ts, and this file's own
 * getSessionInfo and endSession) - two already filtered ended_at correctly
 * (mcp.ts, endSession), two didn't (status.ts, getSessionInfo), so kg_status
 * kept reporting an ended session as current while kg_node_create's gate (via
 * mcp.ts) correctly refused it.
 */
export async function resolveActiveSession(db: KgDbClient, tenantId: string): Promise<SessionRecord | null> {
  return db.queryOne<SessionRecord>(
    "SELECT *, project.name AS project_name, tenant.name AS tenant_name FROM session WHERE ended_at IS NONE AND tenant = type::record('tenant', $tenant_id) ORDER BY started_at DESC LIMIT 1",
    { tenant_id: tenantId }
  );
}
