// SPDX-License-Identifier: Elastic-2.0
// Copyright 2024-2026 Komplyzen GmbH. Licensed under the Elastic License 2.0; see LICENSE in this directory.

/**
 * Admin-initiated container soft-delete.
 *
 * The DB operation behind DELETE /admin/tenants/:tenantId/containers/:containerId.
 * Runs on a root connection (staff never hold a token scoped to the target
 * tenant), but only ever soft-deletes — hard deletion remains exclusive to
 * the purge job after the 30-day window.
 *
 * The audit record is written in the same transaction as the update, and is
 * written even when the delete is an idempotent no-op: the record documents
 * the staff action and its justification (GDPR Art. 28(3)(e) assist-obligation),
 * not the state transition.
 */

import type { Surreal } from 'surrealdb';

export interface AdminSoftDeleteParams {
  containerId: string;
  tenantId: string;
  /** Staff user ID from the caller's JWT (audit actor) */
  actor: string;
  /** Caller-supplied justification, already validated (≥10 chars after trim) */
  reason: string;
}

export interface AdminSoftDeleteResult {
  deleted_at: string;
  first_deleted_at: string;
  audit_id: string;
}

/**
 * Soft-delete a container in any tenant, atomically with its audit record.
 * Returns 'not_found' when the container doesn't exist in that tenant —
 * the transaction (including the audit write) rolls back in that case.
 *
 * Mirrors the tenant-facing route's semantics: idempotent (already-deleted
 * is a no-op that does not reset first_deleted_at).
 */
export async function adminSoftDelete(
  db: Surreal,
  params: AdminSoftDeleteParams
): Promise<AdminSoftDeleteResult | 'not_found'> {
  // Not-found uses a sentinel RETURN, not THROW: a top-level RETURN halts
  // execution AND COMMITS (nothing "rolls back" — the sentinel simply exits
  // before any write statement runs). INVARIANT: the sentinel check must stay
  // ahead of every write in this transaction; reordering would commit writes
  // for a miss without any error. THROW is unusable here: its reason string
  // is swallowed into a generic "failed transaction" error that can't be told
  // apart from a real failure.
  const result = await db.query<unknown[]>(
    `BEGIN TRANSACTION;
     LET $c = (SELECT id, deleted_at, first_deleted_at
       FROM type::record('container', $container_id)
       WHERE tenant = type::record('tenant', $tenant_id))[0];
     IF $c IS NONE { RETURN { found: false } };
     IF $c.deleted_at IS NONE {
       UPDATE type::record('container', $container_id) SET
         deleted_at = time::now(),
         first_deleted_at = first_deleted_at ?? time::now();
     };
     LET $after = (SELECT deleted_at, first_deleted_at
       FROM type::record('container', $container_id))[0];
     LET $audit = (CREATE ONLY audit_log SET
       action = 'admin_soft_delete',
       actor = $actor,
       tenant_id = $tenant_id,
       container_id = $container_id,
       node_count = NONE,
       edge_count = NONE,
       reason = $reason,
       timestamp = time::now());
     RETURN {
       found: true,
       deleted_at: $after.deleted_at,
       first_deleted_at: $after.first_deleted_at,
       audit_id: record::id($audit.id)
     };
     COMMIT TRANSACTION;`,
    {
      container_id: params.containerId,
      tenant_id: params.tenantId,
      actor: params.actor,
      reason: params.reason,
    }
  );

  // Transactions yield one result slot per statement: null for LET/COMMIT,
  // arrays for UPDATE. Our RETURN value is the only plain object carrying
  // the 'found' sentinel key — select by that, never by position.
  const value = result.find(
    (v): v is { found: boolean; deleted_at?: unknown; first_deleted_at?: unknown; audit_id?: unknown } =>
      v !== null && typeof v === 'object' && !Array.isArray(v) && 'found' in v
  );
  if (!value) {
    throw new Error(
      `adminSoftDelete: transaction result missing RETURN value for container ${params.containerId}`
    );
  }
  if (!value.found) return 'not_found';
  return {
    deleted_at: toIso(value.deleted_at),
    first_deleted_at: toIso(value.first_deleted_at),
    audit_id: String(value.audit_id),
  };
}

/**
 * The SDK decodes SurrealDB datetimes as Date objects; String(Date) yields
 * "Mon Aug 24 ...", not ISO-8601, which would diverge from the tenant-facing
 * container routes' response format.
 */
function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  const parsed = new Date(String(v));
  return Number.isNaN(parsed.getTime()) ? String(v) : parsed.toISOString();
}
