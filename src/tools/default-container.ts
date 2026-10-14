/**
 * First-use provisioning of a tenant's default container.
 *
 * Hosted and local mode share this one path. It runs on the caller's own scoped connection, so
 * it only does what the RLS allows: it creates the container and nothing else. Tenant and
 * principal rows are NOT created here: a scoped connection cannot create them (the RLS silently
 * drops those CREATEs), and tenant isolation runs on $auth.tenantId, so nothing reads them.
 *
 * Idempotent and safe under concurrency: the container id is fixed by convention
 * (`<tenantId>_default`, which also marks it for delete protection), so of two simultaneous first
 * writes exactly one CREATE wins and the other re-reads the winner.
 */
import type { KgDbClient } from '../contracts.js';
import { extractRecordId } from '../contracts.js';
import { childLogger } from '../logger.js';

const logger = childLogger('default-container');

export const DEFAULT_CONTAINER_NAME = 'Company Knowledge';

/** The tenant's default container exists but was deleted (soft delete, awaiting purge). */
export class DefaultContainerDeletedError extends Error {
  constructor(tenantId: string) {
    super(`The default container of tenant '${tenantId}' was deleted and is awaiting purge`);
    this.name = 'DefaultContainerDeletedError';
  }
}

/** Only live containers: writing into one that is soft-deleted would lose the data at purge. */
export async function findDefaultContainer(db: KgDbClient, tenantId: string): Promise<string | null> {
  const existing = await db.queryOne<{ id: string }>(
    `SELECT id FROM container
     WHERE tenant = type::record('tenant', $tenant_id) AND name = $name AND deleted_at = NONE LIMIT 1`,
    { tenant_id: tenantId, name: DEFAULT_CONTAINER_NAME }
  );
  return existing?.id ? extractRecordId(existing.id, 'container') : null;
}

async function defaultContainerIsDeleted(db: KgDbClient, tenantId: string): Promise<boolean> {
  const row = await db.queryOne<{ id: string }>(
    `SELECT id FROM container
     WHERE tenant = type::record('tenant', $tenant_id) AND name = $name AND deleted_at != NONE LIMIT 1`,
    { tenant_id: tenantId, name: DEFAULT_CONTAINER_NAME }
  );
  return !!row?.id;
}

/**
 * The failures that mean "someone else is creating it right now": SurrealDB's duplicate-record
 * error, and the write conflict a truly concurrent CREATE of the same id produces. Anything else
 * (connection loss, permissions) is a real failure and is not retried or swallowed.
 */
function isLostRace(err: unknown): boolean {
  return /already exists|can be retried|transaction conflict/i.test(
    String(err instanceof Error ? err.message : err)
  );
}

const CREATE_ATTEMPTS = 3;

/** The tenant's default container id (without the table prefix), created on first use. */
export async function ensureDefaultContainer(db: KgDbClient, tenantId: string): Promise<string> {
  const found = await findDefaultContainer(db, tenantId);
  if (found) return found;

  const principal = `tenant_${tenantId}`;
  for (let attempt = 1; ; attempt++) {
    try {
      await db.queryOne(
        `CREATE type::record('container', $container_id) SET
        name = $name,
        tenant = type::record('tenant', $tenant_id),
        owner = type::record('principal', $principal_id),
        granted_principals = [type::record('principal', $principal_id)],
        created_at = time::now()`,
        {
          container_id: `${tenantId}_default`,
          name: DEFAULT_CONTAINER_NAME,
          tenant_id: tenantId,
          principal_id: principal,
        }
      );
      break;
    } catch (err) {
      if (!isLostRace(err)) {
        logger.error({ err, tenantId }, 'Could not create the default container');
        throw err;
      }
      // Lost the race to a concurrent first write: use the winner's container.
      const winner = await findDefaultContainer(db, tenantId);
      if (winner) return winner;
      // The fixed id is taken but there is no live container: the tenant's default was deleted.
      if (await defaultContainerIsDeleted(db, tenantId)) throw new DefaultContainerDeletedError(tenantId);
      // The winner's write may not be visible yet: try again a few times, then give up.
      if (attempt >= CREATE_ATTEMPTS) {
        logger.error({ err, tenantId }, 'Default container is contended and still not visible');
        throw err;
      }
    }
  }

  const created = await findDefaultContainer(db, tenantId);
  if (!created) throw new Error('Default container was created but cannot be read back');
  return created;
}
