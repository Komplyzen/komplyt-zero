import { Surreal } from 'surrealdb';
import { KgDbClient, KgTokenPayload, DbFactory } from './contracts.js';
import { getEnv } from './env.js';

/**
 * Thrown when a scoped connection is used after the window in which its
 * kg_auth_session row is guaranteed to exist. Past that point the row may have
 * been pruned and every RLS-filtered read silently returns nothing; failing
 * loudly makes the caller reconnect instead of acting on empty data.
 */
export class ScopedSessionExpiredError extends Error {
  constructor(ageMs: number, maxAgeMs: number) {
    super(
      `Scoped database session expired (age ${Math.round(ageMs / 1000)}s, limit ${Math.round(maxAgeMs / 1000)}s): sign in again for each request.`
    );
    this.name = 'ScopedSessionExpiredError';
  }
}

export interface ScopedClientOptions {
  /** Refuse queries once the client is older than this. Undefined = no limit (pruning disabled). */
  maxAgeMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Margin so the guard trips before the pruner could delete the row. */
const SESSION_EXPIRY_MARGIN_MS = 10 * 60 * 1000;

/**
 * How long a scoped client may be used, derived from the pruner's retention:
 * undefined when pruning is off (rows are never deleted, so no limit applies).
 */
export function scopedSessionMaxAgeMs(): number | undefined {
  const env = getEnv();
  if (!env.KG_SESSION_PRUNE) return undefined;
  const retentionMs = env.KG_SESSION_RETENTION_HOURS * 60 * 60 * 1000;
  return Math.max(retentionMs - SESSION_EXPIRY_MARGIN_MS, retentionMs / 2);
}

/** Returns a function that throws ScopedSessionExpiredError once `maxAgeMs` has passed since creation. */
export function createSessionAgeGuard(maxAgeMs: number | undefined, now: () => number = Date.now): () => void {
  const createdAt = now();
  return () => {
    if (maxAgeMs === undefined) return;
    const age = now() - createdAt;
    if (age > maxAgeMs) throw new ScopedSessionExpiredError(age, maxAgeMs);
  };
}

/**
 * Create a tenant-scoped database client.
 * Uses JWT auth so SurrealDB RLS permissions apply via $token.
 */
export function createScopedClient(db: Surreal, options: ScopedClientOptions = {}): KgDbClient {
  const assertFresh = createSessionAgeGuard(options.maxAgeMs, options.now);

  async function query<T>(sql: string, vars?: Record<string, unknown>): Promise<T[]> {
    assertFresh();
    const result = await db.query<T[][]>(sql, vars);
    return result.flat();
  }

  async function queryOne<T>(sql: string, vars?: Record<string, unknown>): Promise<T | null> {
    const results = await query<T>(sql, vars);
    return results[0] ?? null;
  }

  async function close(): Promise<void> {
    await db.close();
  }

  async function release(): Promise<void> {
    await close();
  }

  return { query, queryOne, close, release };
}

/**
 * Factory for creating tenant-scoped database connections.
 * Uses TYPE RECORD signin so SurrealDB RLS permissions are enforced via $auth.
 */
export const dbFactory: DbFactory = {
  // The direct (non-pooled) factory does not honour aborts; pooledDbFactory does.
  async createScoped(claims: KgTokenPayload, _signal?: AbortSignal): Promise<KgDbClient> {
    const env = getEnv();
    const db = new Surreal();

    try {
      await db.connect(env.KG_DB_URL);
    } catch (err) {
      throw new Error(`Failed to connect to SurrealDB at ${env.KG_DB_URL}: ${err}`);
    }

    // Signin with claims + secret - SurrealDB validates secret, creates kg_auth_session,
    // and returns a JWT. RLS then uses $auth (the session record) for permissions.
    // SDK uses {namespace, database, access, variables} format for record access
    try {
      await db.signin({
        namespace: env.KG_DB_NS,
        database: env.KG_DB_NAME,
        access: 'kg_server',
        variables: {
          secret: env.KG_JWT_SECRET,
          tenantId: claims.tenantId,
          principals: claims.principals,
          sub: claims.sub,
          scope: claims.scope,
          projects: claims.projects,
        },
      });
    } catch (err) {
      await db.close();
      throw new Error(`Failed to signin with claims: ${err}`);
    }

    try {
      await db.use({ namespace: env.KG_DB_NS, database: env.KG_DB_NAME });
    } catch (err) {
      await db.close();
      throw new Error(`Failed to select namespace/database ${env.KG_DB_NS}/${env.KG_DB_NAME}: ${err}`);
    }

    return createScopedClient(db, { maxAgeMs: scopedSessionMaxAgeMs() });
  },
};

/**
 * Create a root-level database connection (for migrations, tests).
 * Caller owns lifecycle and MUST call close().
 */
export async function createRootConnection(): Promise<Surreal> {
  const env = getEnv();
  const db = new Surreal();

  try {
    await db.connect(env.KG_DB_URL);
  } catch (err) {
    throw new Error(`Failed to connect to SurrealDB at ${env.KG_DB_URL}: ${err}`);
  }

  try {
    await db.signin({
      username: env.KG_DB_USER,
      password: env.KG_DB_PASS,
    });
  } catch (err) {
    await db.close();
    throw new Error(`Failed to authenticate with SurrealDB: ${err}`);
  }

  try {
    await db.use({ namespace: env.KG_DB_NS, database: env.KG_DB_NAME });
  } catch (err) {
    await db.close();
    throw new Error(`Failed to select namespace/database ${env.KG_DB_NS}/${env.KG_DB_NAME}: ${err}`);
  }

  return db;
}
