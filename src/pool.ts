import { createSessionAgeGuard, scopedSessionMaxAgeMs } from './db.js';
import { Surreal } from 'surrealdb';
import { KgDbClient, KgTokenPayload, DbFactory } from './contracts.js';
import { getEnv } from './env.js';
import { childLogger } from './logger.js';

const logger = childLogger('pool');

// Circuit breaker settings
const BREAKER_THRESHOLD = 5;
const BREAKER_WINDOW_MS = 10_000;
const BREAKER_COOLDOWN_MS = 5_000;
const DRAIN_TIMEOUT_MS = 10_000;

interface CircuitBreaker {
  failures: number;
  lastFailure: number;
  trippedUntil: number;
}

export class PoolExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PoolExhaustedError';
  }
}

export class CircuitBreakerOpenError extends Error {
  retryAfter: number;
  constructor() {
    super('Circuit breaker open - SurrealDB unavailable');
    this.name = 'CircuitBreakerOpenError';
    this.retryAfter = Math.ceil(BREAKER_COOLDOWN_MS / 1000);
  }
}

/**
 * Connection pool that reuses a single WebSocket connection to SurrealDB Cloud.
 *
 * Key insight from SurrealDB Cloud behavior:
 * - Cloud aggressively terminates idle WebSocket connections
 * - On reconnect, all previously cached sessions are orphaned ("session not found")
 * - Sessions cannot be safely pooled across reconnects
 *
 * Solution: Pool the WebSocket connection (expensive: TCP + TLS handshake),
 * but create fresh sessions per request (cheap: 2 round trips for newSession + signin).
 * Each session is disposed after use, avoiding stale session bugs.
 */
class ConnectionPool {
  private rootDb: Surreal | null = null;
  private connectPromise: Promise<Surreal> | null = null;
  private breaker: CircuitBreaker = { failures: 0, lastFailure: 0, trippedUntil: 0 };
  private shuttingDown = false;
  private activeRequests = 0;
  private drainResolvers: Array<() => void> = [];
  /** Count of sessions released via abort signal (HTTP timeout) */
  private abortReleaseCount = 0;

  private checkBreaker(): void {
    if (Date.now() < this.breaker.trippedUntil) {
      throw new CircuitBreakerOpenError();
    }
  }

  private recordFailure(): void {
    const now = Date.now();
    if (now - this.breaker.lastFailure > BREAKER_WINDOW_MS) {
      this.breaker.failures = 0;
    }
    this.breaker.failures++;
    this.breaker.lastFailure = now;
    if (this.breaker.failures >= BREAKER_THRESHOLD) {
      this.breaker.trippedUntil = now + BREAKER_COOLDOWN_MS;
      logger.error('Circuit breaker tripped — SurrealDB unavailable');
    }
  }

  private recordSuccess(): void {
    this.breaker.failures = 0;
  }

  /**
   * Get or create the root WebSocket connection.
   * Connection is reused across all requests.
   */
  private async getConnection(): Promise<Surreal> {
    if (this.shuttingDown) {
      throw new Error('Pool is shutting down');
    }

    this.checkBreaker();

    // Return existing connection if available
    if (this.rootDb) {
      return this.rootDb;
    }

    // Dedupe concurrent connection attempts
    if (!this.connectPromise) {
      this.connectPromise = this.createConnection();
    }

    return this.connectPromise;
  }

  private async createConnection(): Promise<Surreal> {
    const env = getEnv();
    const db = new Surreal();

    try {
      await db.connect(env.KG_DB_URL);
      this.rootDb = db;

      db.subscribe('disconnected', () => {
        logger.warn('WebSocket disconnected');
      });

      db.subscribe('reconnecting', () => {
        logger.info('WebSocket reconnecting...');
      });

      db.subscribe('connected', () => {
        logger.info('WebSocket connected');
      });

      this.recordSuccess();
      logger.info({ url: env.KG_DB_URL }, 'Root WebSocket connection established');
      return db;
    } catch (err) {
      this.connectPromise = null;
      this.rootDb = null;
      this.recordFailure();
      throw new Error(`Failed to connect to SurrealDB at ${env.KG_DB_URL}: ${err}`);
    }
  }

  /**
   * Acquire a scoped database client for a request.
   * Creates a fresh session, signs in with tenant claims, and returns a client.
   * The session is disposed when release() is called or the abort signal fires.
   */
  async acquire(claims: KgTokenPayload, signal?: AbortSignal): Promise<KgDbClient> {
    const db = await this.getConnection();
    const env = getEnv();

    // Create fresh session for this request
    const session = await db.newSession();

    try {
      // Sign in with tenant-scoped credentials for RLS
      await session.signin({
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

      await session.use({ namespace: env.KG_DB_NS, database: env.KG_DB_NAME });
      this.recordSuccess();
    } catch (err) {
      // Clean up session on signin failure
      await session.closeSession().catch(() => {});
      this.recordFailure();
      throw new Error(`Failed to signin with claims: ${err}`);
    }

    this.activeRequests++;
    let released = false;
    let abortHandler: (() => void) | null = null;

    const release = async (): Promise<void> => {
      if (released) {
        logger.warn({ tenantId: claims.tenantId }, 'Duplicate release() call');
        return;
      }
      released = true;

      // Remove abort listener if still attached (normal completion before timeout)
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
        abortHandler = null;
      }

      // Dispose the session - it's not reusable after Cloud reconnects anyway
      await session.closeSession().catch((err) => {
        logger.debug({ err, tenantId: claims.tenantId }, 'Session close failed (may already be closed)');
      });

      this.activeRequests--;
      this.checkDrainComplete();
    };

    // Auto-release on abort (HTTP timeout)
    if (signal) {
      abortHandler = () => {
        if (!released) {
          this.abortReleaseCount++;
          logger.warn({ tenantId: claims.tenantId }, 'Session released by abort signal (HTTP timeout)');
          release().catch((err) => {
            logger.error({ err, tenantId: claims.tenantId }, 'Failed to release session on abort');
          });
        }
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    // Fail loudly if a caller holds this session past the window in which its
    // kg_auth_session row exists (see db.ts); normal requests never come close.
    const assertFresh = createSessionAgeGuard(scopedSessionMaxAgeMs());

    async function query<T>(sql: string, vars?: Record<string, unknown>): Promise<T[]> {
      assertFresh();
      const result = await session.query<T[][]>(sql, vars);
      return result.flat();
    }

    async function queryOne<T>(sql: string, vars?: Record<string, unknown>): Promise<T | null> {
      const results = await query<T>(sql, vars);
      return results[0] ?? null;
    }

    async function close(): Promise<void> {
      await release();
    }

    return { query, queryOne, close, release };
  }

  private checkDrainComplete(): void {
    if (this.activeRequests === 0 && this.drainResolvers.length > 0) {
      for (const resolve of this.drainResolvers) {
        resolve();
      }
      this.drainResolvers = [];
    }
  }

  stopAccepting(): void {
    this.shuttingDown = true;
  }

  waitForAllReleased(): Promise<void> {
    if (this.activeRequests === 0) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.drainResolvers.push(resolve);
    });
  }

  async closeAll(): Promise<void> {
    if (this.rootDb) {
      await this.rootDb.close().catch(() => {});
      this.rootDb = null;
      this.connectPromise = null;
    }
    logger.info('Connection pool closed');
  }

  getMetrics(): {
    connected: boolean;
    activeRequests: number;
    circuitBreakerOpen: boolean;
    abortReleaseCount: number;
  } {
    return {
      connected: this.rootDb !== null,
      activeRequests: this.activeRequests,
      circuitBreakerOpen: Date.now() < this.breaker.trippedUntil,
      abortReleaseCount: this.abortReleaseCount,
    };
  }
}

let pool: ConnectionPool | null = null;

function getPool(): ConnectionPool {
  if (!pool) {
    pool = new ConnectionPool();
  }
  return pool;
}

export const pooledDbFactory: DbFactory = {
  async createScoped(claims: KgTokenPayload, signal?: AbortSignal): Promise<KgDbClient> {
    return getPool().acquire(claims, signal);
  },
};

export function getPoolMetrics(): ReturnType<ConnectionPool['getMetrics']> {
  return getPool().getMetrics();
}

export async function gracefulShutdown(): Promise<void> {
  if (!pool) return;

  pool.stopAccepting();

  await Promise.race([
    pool.waitForAllReleased(),
    new Promise<void>(resolve => setTimeout(resolve, DRAIN_TIMEOUT_MS)),
  ]);

  await pool.closeAll();
  pool = null;
}

export async function _resetPoolForTesting(): Promise<void> {
  if (pool) {
    await pool.closeAll().catch(() => {});
    pool = null;
  }
}
