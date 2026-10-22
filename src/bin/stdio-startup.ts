/**
 * The stdio server's startup (credentials, sign-in secret, embedding provider, sign-in check) runs in
 * the background so `initialize` and `tools/list` never wait for the database. Tool calls that need
 * it ask `ready()`.
 *
 * Single-flight: concurrent callers share one run. A failed run is remembered for a cooldown, so a
 * client that times out and retries cannot stack attempts (the sign-in secret publish has its own
 * retry budget that no circuit breaker covers); the first call after the cooldown starts a new run.
 */

/** How long a tool call waits for a running startup before answering "still starting". */
export const STARTUP_WAIT_MS = 10_000;
/** After a failed startup, calls fail immediately with the last error for this long. */
export const STARTUP_RETRY_COOLDOWN_MS = 30_000;

export class StartupPendingError extends Error {
  constructor() {
    super('The server is still starting (database or embedding provider not ready yet). Retry in a few seconds.');
    this.name = 'StartupPendingError';
  }
}

export class StartupFailedError extends Error {
  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`The server could not start: ${reason}. Check the database and embedding settings (docs/self-hosting.md).`, { cause });
    this.name = 'StartupFailedError';
  }
}

export interface StartupOptions {
  waitMs?: number;
  cooldownMs?: number;
  now?: () => number;
}

export interface Startup<T> {
  /** Starts a run now unless one is running, finished, or cooling down after a failure. Never throws. */
  begin(): void;
  /** The started value; throws StartupPendingError or StartupFailedError. */
  ready(): Promise<T>;
}

export function createStartup<T>(run: () => Promise<T>, options: StartupOptions = {}): Startup<T> {
  const { waitMs = STARTUP_WAIT_MS, cooldownMs = STARTUP_RETRY_COOLDOWN_MS, now = Date.now } = options;

  let attempt: Promise<T> | null = null;
  let failure: { error: StartupFailedError; at: number } | null = null;
  let done: { value: T } | null = null;

  function start(): Promise<T> {
    attempt = run().then(
      (value) => {
        done = { value };
        return value;
      },
      (cause: unknown) => {
        const error = new StartupFailedError(cause);
        failure = { error, at: now() };
        attempt = null;
        throw error;
      }
    );
    attempt.catch(() => {}); // the failure is reported to whoever asks next
    return attempt;
  }

  function begin(): void {
    if (done || attempt || (failure && now() - failure.at < cooldownMs)) return;
    start();
  }

  async function ready(): Promise<T> {
    if (done) return done.value;
    if (failure && now() - failure.at < cooldownMs) throw failure.error;

    const running = attempt ?? start();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StartupPendingError()), waitMs);
    });
    try {
      return await Promise.race([running, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return { begin, ready };
}
