/**
 * Remembers each tenant's subscription tier in the graph.
 *
 * Komplyt owns the tier; the graph only ever sees it inside verified tokens. The private batch job that
 * computes the meta-models limits itself to licensed workspaces that are still active, and it can only
 * read the graph database, so the server notes each tenant's tier in `tenant_tier` (migration 037, a
 * table no tenant can read or write).
 *
 * This is bookkeeping, never on the request's critical path: `note` returns at once, a failed or hung
 * write is logged and given up on, and the next sighting tries again.
 *
 * A token is not a plan. Several tokens of one tenant can carry different tiers (a free member of a team
 * tenant, a stale token after an upgrade, a connector), so the recorder keeps the HIGHEST tier seen in
 * each window and writes that: an upgrade is written at once, a downgrade only after a whole window in
 * which no token showed the higher tier. That also bounds the writes (one per window, plus at most one
 * per upgrade step) however many requests or alternating tokens arrive.
 */
import type { Surreal } from 'surrealdb';
import { childLogger } from './logger.js';

const logger = childLogger('tenant-tier');

/** Ordered by what the tier grants; `pro` is a personal plan, below the business tiers. */
const RANK: Record<string, number> = { free: 0, pro: 1, team: 2, enterprise: 3 };

export interface TierWriter {
  upsertTier(tenantId: string, tier: string): Promise<void>;
}

export interface TierRecorder {
  note(tenantId: string, tier: string): void;
  size(): number;
}

export interface TierRecorderOptions {
  /** Window length: how often an unchanged tier is refreshed ("last seen") and a downgrade can land. */
  ttlMs: number;
  now?: () => number;
  /** Safety bound on tracked tenants. */
  maxTenants?: number;
  /** A write that takes longer than this is given up on (the tenant is retried at its next sighting). */
  writeTimeoutMs?: number;
}

interface Entry {
  /** The tier last written successfully; null until one has been. */
  written: string | null;
  windowStart: number;
  /** Highest tier seen in the current window. */
  windowMax: string;
  pending: boolean;
}

const rank = (tier: string | null): number => (tier === null ? -1 : (RANK[tier] ?? -1));
const higher = (a: string, b: string): string => (rank(b) > rank(a) ? b : a);

export function createTenantTierRecorder(writer: TierWriter, options: TierRecorderOptions): TierRecorder {
  const now = options.now ?? Date.now;
  const maxTenants = options.maxTenants ?? 10_000;
  const writeTimeoutMs = options.writeTimeoutMs ?? 10_000;
  const entries = new Map<string, Entry>();

  function write(tenantId: string, entry: Entry, tier: string): void {
    entry.pending = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`recording the tier timed out after ${writeTimeoutMs}ms`)),
        writeTimeoutMs
      );
    });
    Promise.race([writer.upsertTier(tenantId, tier), timeout])
      .then(() => {
        entry.written = tier;
      })
      .catch((err) => {
        // Make the next sighting open a new window and write again.
        entry.windowStart = Number.NEGATIVE_INFINITY;
        logger.warn({ err, tenantId }, 'Could not record the tenant tier');
      })
      .finally(() => {
        clearTimeout(timer);
        entry.pending = false;
      });
  }

  return {
    note(tenantId, tier) {
      if (!tenantId || !Object.hasOwn(RANK, tier)) return;
      const t = now();
      let entry = entries.get(tenantId);

      if (!entry) {
        if (entries.size >= maxTenants) entries.clear();
        entry = { written: null, windowStart: t, windowMax: tier, pending: false };
        entries.set(tenantId, entry);
        write(tenantId, entry, tier);
        return;
      }

      let target: string | null = null;
      if (t - entry.windowStart >= options.ttlMs) {
        // The window is over: write its highest tier (this refreshes "last seen" and lets a downgrade land).
        target = entry.windowMax;
        entry.windowStart = t;
        entry.windowMax = tier;
      } else {
        entry.windowMax = higher(entry.windowMax, tier);
      }
      // An upgrade over what is stored is written at once.
      if (rank(tier) > rank(entry.written)) target = target === null ? tier : higher(target, tier);

      if (target !== null && !entry.pending) write(tenantId, entry, target);
    },
    size: () => entries.size,
  };
}

/** Opens a root connection. The caller closes it (the same contract as db.ts createRootConnection). */
export type RootConnect = () => Promise<Surreal>;

export interface RootTierWriterOptions {
  /** A write (connect plus query) that takes longer than this fails and its connection is closed. */
  timeoutMs?: number;
}

/**
 * Writes through a short-lived root connection per write, as the admin routes do. `tenant_tier` is
 * PERMISSIONS NONE, so only root can write it; a write happens at most about once per tenant per hour,
 * so opening a connection each time costs nothing and leaves no connection lifecycle to manage.
 */
export function createRootTierWriter(connect: RootConnect, options: RootTierWriterOptions = {}): TierWriter {
  const timeoutMs = options.timeoutMs ?? 5_000;
  return {
    async upsertTier(tenantId, tier) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let db: Surreal | undefined;
      let closed = false;
      const close = (): void => {
        if (db && !closed) {
          closed = true;
          void Promise.resolve(db.close()).catch(() => {});
        }
      };
      const write = (async () => {
        db = await connect();
        // changed_at is assigned before tier so it compares with the value that is still stored.
        await db.query(
          `UPSERT type::record('tenant_tier', $id) SET
             changed_at = IF tier = $tier { changed_at } ELSE { time::now() },
             tier = $tier,
             updated_at = time::now()`,
          { id: tenantId, tier }
        );
      })();
      // A write that finishes (or fails) after the timeout still releases its connection.
      write.then(close, close);
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`tier write timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        await Promise.race([write, timeout]);
      } finally {
        clearTimeout(timer);
        close();
      }
    },
  };
}

/**
 * True when migration 037 is applied (the table can be read). Never throws: a server that boots before
 * the migration, or while the database is unreachable, must still serve.
 */
export async function checkTenantTierTable(connect: RootConnect): Promise<boolean> {
  let db: Surreal | undefined;
  try {
    db = await connect();
    await db.query('SELECT id FROM tenant_tier LIMIT 1');
    return true;
  } catch (err) {
    logger.error(
      { err },
      'The tenant_tier table is not readable: apply migration 037 or the batch job will see no tiers'
    );
    return false;
  } finally {
    await Promise.resolve(db?.close()).catch(() => {});
  }
}

let installed: TierRecorder | null = null;

export function installTenantTierRecorder(recorder: TierRecorder | null): void {
  installed = recorder;
}

/** Called from token verification. A no-op until the server installs a recorder (tests, local mode, CLI). */
export function noteTenantTier(tenantId: string, tier: string): void {
  installed?.note(tenantId, tier);
}
