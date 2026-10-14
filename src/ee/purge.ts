// SPDX-License-Identifier: Elastic-2.0
// Copyright 2024-2026 Komplyzen GmbH. Licensed under the Elastic License 2.0; see LICENSE in this directory.

/**
 * Container hard-purge.
 *
 * Irreversibly deletes containers soft-deleted PURGE_RETENTION_DAYS+ days ago,
 * cascading to their nodes and every edge touching those nodes, and to the data derived from them
 * (stored meta-models, training runs), with an audit record written in the same transaction.
 *
 * Runs exclusively on a root connection (caller-provided): `FOR delete NONE`
 * stays in force for every tenant-scoped connection, so this module is the
 * only delete path in the codebase. There is deliberately NO RLS backstop
 * here — correctness rests on the eligibility predicate below never taking
 * caller input.
 */

import type { Surreal } from 'surrealdb';
import { PURGE_RETENTION_DAYS, extractRecordId } from '../contracts.js';
import { childLogger } from '../logger.js';

const logger = childLogger('purge');

/** Actor recorded in audit_log for job-initiated purges */
export const PURGE_ACTOR = 'purge-job';

export interface PurgedContainer {
  container: string;
  tenant: string;
  node_count: number;
  edge_count: number;
  audit_id: string;
}

export interface PurgeRunResult {
  eligible: number;
  purged: PurgedContainer[];
  /** Containers left untouched: restored (or already gone) between selection and purge */
  skipped: string[];
  failures: { container: string; error: string }[];
}

interface EligibleRow {
  id: string | { tb: string; id: string };
  tenant: string | { tb: string; id: string };
}

/**
 * Purge one container atomically: container + nodes + touching edges + audit
 * record in a single transaction. Rolls back entirely on any failure — a
 * partial purge is a GDPR compliance failure (data the subject requested
 * deleted still exists) and would orphan edge references.
 *
 * Re-checks `deleted_at` inside the transaction: a container restored between
 * eligibility selection and this call must be left untouched.
 *
 * Edge cascade deletes every edge where a purged node is `in` OR `out` — a
 * node can be linked across containers, and such an edge would otherwise
 * become a dangling reference to a deleted record. The container's `granted`
 * relation rows (container→principal grants, tenant data in their own right)
 * are cascaded for the same reason.
 */
export async function purgeContainer(
  db: Surreal,
  containerId: string,
  tenantId: string
): Promise<{ node_count: number; edge_count: number; audit_id: string } | 'skipped'> {
  // Eligibility re-check uses a sentinel RETURN, not THROW: a top-level RETURN
  // halts the transaction before any delete runs AND commits (the trailing
  // COMMIT is then unreachable) — both behaviors verified empirically against
  // SurrealDB v3.0.0, which is what CI/local tests pin. THROW is unusable
  // here: its reason string is swallowed into a generic "failed transaction"
  // error that can't be told apart from a real failure.
  //
  // The sentinel covers BOTH "restored" and "already gone" (e.g. a concurrent
  // purge run won the race) — either way this run must not touch anything.
  const result = await db.query<unknown[]>(
    `BEGIN TRANSACTION;
     LET $c = (SELECT id, deleted_at FROM type::record('container', $container_id))[0];
     IF $c IS NONE OR $c.deleted_at IS NONE { RETURN { restored: true } };
     LET $nodes = (SELECT VALUE id FROM node WHERE container = type::record('container', $container_id));
     LET $edges = (SELECT VALUE id FROM edge WHERE in IN $nodes OR out IN $nodes);
     DELETE edge WHERE in IN $nodes OR out IN $nodes;
     DELETE node WHERE container = type::record('container', $container_id);
     DELETE granted WHERE in = type::record('container', $container_id);
     DELETE meta_model WHERE container = type::record('container', $container_id);
     DELETE training_run WHERE container = type::record('container', $container_id);
     DELETE type::record('container', $container_id);
     LET $audit = (CREATE ONLY audit_log SET
       action = 'container_purge',
       actor = $actor,
       tenant_id = $tenant_id,
       container_id = $container_id,
       node_count = array::len($nodes),
       edge_count = array::len($edges),
       reason = NONE,
       timestamp = time::now());
     RETURN {
       restored: false,
       node_count: array::len($nodes),
       edge_count: array::len($edges),
       audit_id: record::id($audit.id)
     };
     COMMIT TRANSACTION;`,
    { container_id: containerId, tenant_id: tenantId, actor: PURGE_ACTOR }
  );

  // Transactions yield one result slot per statement: null for LET/COMMIT,
  // arrays for DELETE/UPDATE. Our RETURN value is the only plain object
  // carrying the 'restored' sentinel key — select by that, never by position.
  const value = result.find(
    (v): v is { restored: boolean; node_count?: number; edge_count?: number; audit_id?: unknown } =>
      v !== null && typeof v === 'object' && !Array.isArray(v) && 'restored' in v
  );
  if (!value) {
    throw new Error(`purgeContainer: transaction result missing RETURN value for container ${containerId}`);
  }
  if (value.restored) return 'skipped';
  return {
    node_count: value.node_count ?? 0,
    edge_count: value.edge_count ?? 0,
    audit_id: String(value.audit_id),
  };
}

/**
 * Find and purge all eligible containers. Eligibility is keyed off
 * `first_deleted_at` (survives delete/restore cycles), NOT `deleted_at`:
 * delete → restore → delete again still purges 30 days after the FIRST
 * delete. A currently-restored container (deleted_at cleared) is never
 * eligible regardless of first_deleted_at.
 *
 * Each container purges in its own transaction so one failure doesn't
 * roll back the rest of the run.
 */
export async function runPurge(db: Surreal): Promise<PurgeRunResult> {
  const cutoff = new Date(
    Date.now() - PURGE_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const rows = await db.query<EligibleRow[][]>(
    `SELECT id, tenant FROM container
     WHERE deleted_at IS NOT NONE
       AND first_deleted_at IS NOT NONE
       AND first_deleted_at <= type::datetime($cutoff)`,
    { cutoff }
  );
  const eligible = rows.flat();

  const result: PurgeRunResult = {
    eligible: eligible.length,
    purged: [],
    skipped: [],
    failures: [],
  };

  for (const row of eligible) {
    const containerId = extractRecordId(row.id, 'container');
    const tenantId = extractRecordId(row.tenant, 'tenant');
    try {
      const outcome = await purgeContainer(db, containerId, tenantId);
      if (outcome === 'skipped') {
        result.skipped.push(containerId);
        continue;
      }
      result.purged.push({
        container: containerId,
        tenant: tenantId,
        ...outcome,
      });
      logger.info(
        {
          event: 'container_purged',
          tenant: tenantId,
          container: containerId,
          nodeCount: outcome.node_count,
          edgeCount: outcome.edge_count,
          auditId: outcome.audit_id,
        },
        'Container purged'
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      result.failures.push({ container: containerId, error });
      logger.error(
        { event: 'container_purge_failed', tenant: tenantId, container: containerId, error },
        'Container purge failed'
      );
    }
  }

  // Heartbeat: every run logs with this event type, including "0 eligible" —
  // Better Stack monitoring alerts if no purge_run entries appear for 48h.
  logger.info(
    {
      event: 'container_purge_run',
      eligible: result.eligible,
      purged: result.purged.length,
      skipped: result.skipped.length,
      failed: result.failures.length,
    },
    result.eligible === 0
      ? 'Purge run complete: 0 eligible'
      : `Purge run complete: ${result.purged.length}/${result.eligible} purged`
  );

  return result;
}
