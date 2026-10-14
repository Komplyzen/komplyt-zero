import type { Surreal } from 'surrealdb';
import { childLogger } from './logger.js';

const logger = childLogger('session-prune');

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * Default retention. Pool sessions live for one request and tokens for 1h, but
 * stdio CLIs older than the per-call signin change hold one connection for
 * their whole process lifetime: a day keeps an ordinary editor session alive.
 */
export const DEFAULT_SESSION_RETENTION_MS = 24 * HOUR_MS;
export const DEFAULT_PRUNE_INTERVAL_MS = HOUR_MS;

const DEFAULT_BATCH_SIZE = 5_000;
/** Per run: bounds one run at ~500k rows. A capped run is followed up quickly, not an interval later. */
const DEFAULT_MAX_BATCHES = 100;
const DEFAULT_PAUSE_MS = 100;
const BATCH_RETRIES = 3;
const FIRST_RUN_JITTER_MAX_MS = MINUTE_MS;
const DEFAULT_FOLLOW_UP_DELAY_MS = MINUTE_MS;
/** One run (connect + every batch) must finish within this, or it is abandoned and counted as a failure. */
const DEFAULT_RUN_TIMEOUT_MS = 5 * MINUTE_MS;
/** How long stop() waits for a run in flight before giving up on it. Shutdown must not hang on the janitor. */
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const CLOSE_TIMEOUT_MS = 2_000;
const ESCALATE_AFTER_FAILURES = 3;

export interface PruneOptions {
  batchSize?: number;
  /** Stop after this many batches even if more rows are due; the follow-up run continues. */
  maxBatches?: number;
  /** Sleep between batches so a backlog never hogs the database. */
  pauseMs?: number;
  /** Checked before each batch; return true to end the run early. */
  shouldStop?: () => boolean;
}

export interface PruneResult {
  removed: number;
  /** True when maxBatches ended the run while rows were still due. */
  capped: boolean;
  /**
   * Rows left in the table after a run that ran to completion (undefined when
   * the run was capped or stopped, which is when the count would be misleading).
   * A table that keeps growing while runs "succeed" means the pruner is matching nothing.
   */
  remaining?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** SurrealDB reports a conflicted commit as "...a read or write conflict. This transaction can be retried". */
function isConflict(err: unknown): boolean {
  return /read or write conflict|transaction can be retried/i.test(String(err));
}

async function deleteBatch(db: Surreal, age: string, batch: number): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await db.query<[null, unknown, number]>(
        `LET $ids = SELECT VALUE id FROM kg_auth_session
           WHERE created_at < time::now() - type::duration($age) LIMIT $batch;
         DELETE $ids;
         RETURN array::len($ids);`,
        { age, batch }
      );
      return result[2];
    } catch (err) {
      // Concurrent instances prune the same rows; retry a conflicted batch
      // rather than abandoning the run.
      if (!isConflict(err) || attempt >= BATCH_RETRIES) throw err;
      await sleep(100 * (attempt + 1));
    }
  }
}

async function countRows(db: Surreal): Promise<number> {
  const [rows] = await db.query<[{ count: number }[]]>('SELECT count() AS count FROM kg_auth_session GROUP ALL');
  return rows[0]?.count ?? 0;
}

/**
 * Delete kg_auth_session rows created more than `maxAgeMs` ago. Every scoped
 * request signs in and SIGNIN creates a row, so without this the table grows
 * with traffic. Needs a root connection (scoped users cannot delete).
 * Deletes in paced, capped batches so a large backlog never becomes one huge
 * transaction or an unbounded loop.
 */
export async function pruneAuthSessions(
  db: Surreal,
  maxAgeMs: number,
  options: PruneOptions = {}
): Promise<PruneResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  const pauseMs = options.pauseMs ?? DEFAULT_PAUSE_MS;
  const age = `${Math.max(1, Math.floor(maxAgeMs / 1000))}s`;

  let removed = 0;
  for (let i = 0; i < maxBatches; i++) {
    if (options.shouldStop?.()) return { removed, capped: false };

    const n = await deleteBatch(db, age, batchSize);
    removed += n;
    if (n < batchSize) return { removed, capped: false, remaining: await countRows(db) };
    if (pauseMs > 0) await sleep(pauseMs);
  }
  return { removed, capped: true };
}

export interface SessionPrunerOptions {
  /** Root connection factory; each run opens and closes its own connection. */
  connect: () => Promise<Surreal>;
  intervalMs?: number;
  maxAgeMs?: number;
  /** Delay before the first run. Default: random up to 1 min, so instances booting together do not stampede. */
  initialDelayMs?: number;
  /** Delay before the follow-up run after a capped run. Default 1 min. */
  followUpDelayMs?: number;
  /** Abandon a run (connect + batches) that takes longer than this. Default 5 min. */
  runTimeoutMs?: number;
  /** How long stop() waits for a run in flight. Default 2 s. */
  stopTimeoutMs?: number;
  pruneOptions?: PruneOptions;
  /** Observability hooks; the pruner knows nothing about the metrics module. */
  onRun?: (result: PruneResult) => void;
  onFailure?: (err: unknown) => void;
}

async function closeQuietly(db: Surreal | undefined): Promise<void> {
  if (!db) return;
  // A socket that is already dead can make close() hang; never let cleanup
  // keep the pruner's in-flight marker set.
  await Promise.race([db.close().catch(() => {}), sleep(CLOSE_TIMEOUT_MS)]);
}

/**
 * Prune after a short jittered delay, then on an interval, until the returned
 * stop function is called. A run that ends capped is followed up after a
 * short delay instead of waiting a whole interval, so throughput is not
 * limited to one capped run per interval.
 *
 * A run that exceeds `runTimeoutMs` (a connect that never settles, a stuck
 * query) is abandoned and counted as a failure; without that, one hung
 * connection would block every later run and nothing would say so. Failures
 * are logged and retried, never thrown into the server; the third consecutive
 * one logs at error level, because a pruner that silently stops working is
 * how the table grew unnoticed in the first place.
 *
 * stop() returns once the run in flight ends, or after `stopTimeoutMs`
 * whichever is first: shutdown must not hang on a janitor.
 */
export function startSessionPruner(options: SessionPrunerOptions): () => Promise<void> {
  const intervalMs = options.intervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_SESSION_RETENTION_MS;
  const initialDelayMs =
    options.initialDelayMs ?? Math.floor(Math.random() * Math.min(FIRST_RUN_JITTER_MAX_MS, intervalMs));
  const followUpDelayMs = options.followUpDelayMs ?? DEFAULT_FOLLOW_UP_DELAY_MS;
  const runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

  let inFlight: Promise<void> | undefined;
  let stopped = false;
  let consecutiveFailures = 0;
  let followUp: ReturnType<typeof setTimeout> | undefined;

  async function run(): Promise<PruneResult | undefined> {
    let db: Surreal | undefined;
    let abandoned = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const work = (async (): Promise<PruneResult | undefined> => {
      const conn = await options.connect();
      if (abandoned) {
        await closeQuietly(conn);
        return undefined;
      }
      db = conn;
      return pruneAuthSessions(conn, maxAgeMs, {
        ...options.pruneOptions,
        shouldStop: () => stopped || abandoned,
      });
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abandoned = true;
        reject(new Error(`kg_auth_session prune run timed out after ${runTimeoutMs}ms`));
      }, runTimeoutMs);
    });

    try {
      const result = await Promise.race([work, timeout]);
      if (!result) return undefined;
      consecutiveFailures = 0;
      options.onRun?.(result);
      if (result.removed > 0 || result.capped) {
        const log = result.capped ? logger.warn.bind(logger) : logger.info.bind(logger);
        log(
          { removed: result.removed, capped: result.capped, remaining: result.remaining },
          result.capped
            ? 'Pruned kg_auth_session rows; backlog remains, following up shortly'
            : 'Pruned expired kg_auth_session rows'
        );
      }
      return result;
    } catch (err) {
      consecutiveFailures++;
      options.onFailure?.(err);
      const log = consecutiveFailures >= ESCALATE_AFTER_FAILURES ? logger.error.bind(logger) : logger.warn.bind(logger);
      log({ err, consecutiveFailures }, 'kg_auth_session prune failed; will retry next interval');
      return undefined;
    } finally {
      clearTimeout(timer);
      // The loser's eventual rejection no longer matters.
      work.catch(() => {});
      await closeQuietly(db);
    }
  }

  function tick(): void {
    if (inFlight || stopped) return;
    inFlight = run()
      .then((result) => {
        if (result?.capped && !stopped) {
          followUp = setTimeout(tick, followUpDelayMs);
          followUp.unref();
        }
      })
      .finally(() => {
        inFlight = undefined;
      });
  }

  const firstRun = setTimeout(tick, initialDelayMs);
  const timer = setInterval(tick, intervalMs);
  firstRun.unref();
  timer.unref();

  return async () => {
    stopped = true;
    clearTimeout(firstRun);
    clearTimeout(followUp);
    clearInterval(timer);
    if (!inFlight) return;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      inFlight,
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, stopTimeoutMs);
      }),
    ]);
    clearTimeout(deadline);
  };
}
