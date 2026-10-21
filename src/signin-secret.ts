import { createHash } from 'crypto';
import type { Surreal } from 'surrealdb';
import { createRootConnection } from './db.js';
import { getEnv } from './env.js';
import { childLogger } from './logger.js';

const logger = childLogger('signin-secret');

/**
 * Base for failures that retrying cannot fix: an operator must change the
 * allowlist row or the migration state, not restart the process.
 */
export class SigninAllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigninAllowlistError';
  }
}

/**
 * Thrown when this server's KG_JWT_SECRET hash is not in kg_config:signin's
 * allowlist. Fixing it means adding the hash per the rotation steps in
 * docs/signin-secret.md.
 */
export class SigninSecretNotAcceptedError extends SigninAllowlistError {
  constructor(message: string) {
    super(message);
    this.name = 'SigninSecretNotAcceptedError';
  }
}

export interface PublishOptions {
  /** Root connection factory; the caller of each attempt's connection is this module (it closes it). */
  connect?: () => Promise<Surreal>;
  /** The secret whose sha256 is published. Defaults to KG_JWT_SECRET. */
  secret?: string;
  retryDelaysMs?: readonly number[];
  attemptTimeoutMs?: number;
}

// 1+2+4+8+16 s of backoff plus 6 attempts x 10 s = ~91 s worst case, which
// must fit the Cloud Run startup probe.
const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;

export function sha256Hex(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Without strict mode, SELECT on an undefined table returns NONE, and the
 * first-boot CREATE would then build a schemaless kg_config (no hex
 * assertion, no PERMISSIONS NONE). Check the schema instead of relying on an
 * error message.
 */
export async function assertAllowlistTableDefined(db: Surreal): Promise<void> {
  const [info] = await db.query<[{ tables?: Record<string, string> }]>('INFO FOR DB');
  if (!info?.tables || !('kg_config' in info.tables)) {
    throw new SigninAllowlistError(
      'Table kg_config is not defined: apply database/migrations before booting this server.'
    );
  }
}

async function readAllowlist(db: Surreal): Promise<string[] | null> {
  const [rows] = await db.query<[{ signin_sha256s?: unknown } | null]>(
    'SELECT signin_sha256s FROM ONLY kg_config:signin'
  );
  if (rows === null || rows === undefined) return null;

  const list = (rows as { signin_sha256s?: unknown }).signin_sha256s;
  if (!Array.isArray(list)) {
    throw new SigninAllowlistError(
      'kg_config:signin exists but signin_sha256s is not an array; repair the row before booting this server.'
    );
  }
  return list as string[];
}

async function publishOnce(db: Surreal, ownHash: string): Promise<void> {
  await assertAllowlistTableDefined(db);
  const existing = await readAllowlist(db);

  if (existing === null) {
    // First boot on this database. CREATE, never UPSERT: a concurrent
    // second instance racing this boot fails its CREATE (duplicate id), falls
    // into the retry loop, re-reads, and finds the winner's row.
    await db.query('CREATE kg_config:signin SET signin_sha256s = [$hash]', { hash: ownHash });
    // Confirm by re-reading rather than trusting the CREATE alone.
    const confirmed = await readAllowlist(db);
    if (!confirmed?.includes(ownHash)) {
      throw new SigninSecretNotAcceptedError(
        'kg_config:signin was written by another instance with a different KG_JWT_SECRET.'
      );
    }
    logger.info('Published signin secret hash to kg_config:signin (first boot)');
    return;
  }

  if (existing.includes(ownHash)) return;

  // Row exists, hash absent: config mismatch. Never auto-append — a process
  // with DB credentials and a stale or wrong secret must not self-allowlist.
  throw new SigninSecretNotAcceptedError(
    'KG_JWT_SECRET hash is not in kg_config:signin.signin_sha256s. ' +
      'Add it via the rotation steps in docs/signin-secret.md before this server can sign in. ' +
      'A secret generated per run causes this; keep it fixed (compose: `.env`, see docs/self-hosting.md#secrets).'
  );
}

/**
 * One attempt: connect, publish, always close. On timeout the connection is
 * closed even if it was still being established; a late CREATE from the
 * abandoned attempt is harmless: the next attempt re-reads, and a duplicate-id failure just costs one retry.
 */
async function attempt(connect: () => Promise<Surreal>, ownHash: string, timeoutMs: number): Promise<void> {
  let db: Surreal | undefined;
  let abandoned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const work = (async () => {
    const conn = await connect();
    if (abandoned) {
      await conn.close().catch(() => {});
      return;
    }
    db = conn;
    await publishOnce(conn, ownHash);
  })();

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abandoned = true;
      reject(new Error(`publishSigninSecret attempt timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    // Silence the loser's eventual rejection; its outcome no longer matters.
    work.catch(() => {});
    await db?.close().catch(() => {});
  }
}

/**
 * Publish this server's KG_JWT_SECRET hash to the signin allowlist at boot,
 * over a root connection, so the allowlist-enforcing SIGNIN accepts it.
 * Must complete before the server accepts traffic.
 *
 * Transient failures retry with doubling delays; SigninAllowlistError
 * (rejected hash, malformed row, missing table) fails immediately.
 */
export async function publishSigninSecret(options: PublishOptions = {}): Promise<void> {
  const connect = options.connect ?? createRootConnection;
  const secret = options.secret ?? getEnv().KG_JWT_SECRET;
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const timeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const ownHash = sha256Hex(secret);

  for (let i = 0; ; i++) {
    try {
      await attempt(connect, ownHash, timeoutMs);
      return;
    } catch (err) {
      if (err instanceof SigninAllowlistError || i >= delays.length) throw err;
      logger.warn({ err, attempt: i, delayMs: delays[i] }, 'publishSigninSecret attempt failed, retrying');
      await new Promise((resolve) => setTimeout(resolve, delays[i]));
    }
  }
}
