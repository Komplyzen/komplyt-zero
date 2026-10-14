/**
 * Integration tests for publishSigninSecret against the real migration chain
 * (the kg_config table; enforcement is covered by signin-enforce.integration).
 *
 * Run with: bun run vitest run signin-secret.integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { connectTestDb } from './connect.js';
import {
  publishSigninSecret,
  sha256Hex,
  SigninSecretNotAcceptedError,
} from '../signin-secret.js';
import { createRootConnection } from '../db.js';
import { getEnv } from '../env.js';

const OWN_SECRET = () => getEnv().KG_JWT_SECRET;
const OTHER_SECRET = 'a-different-secret-that-is-32-chars-long!';
const FAST = { retryDelaysMs: [50, 50], attemptTimeoutMs: 5_000 } as const;

let rootDb: Surreal;

async function allowlist(): Promise<string[] | null> {
  const [row] = await rootDb.query<[{ signin_sha256s: string[] } | null]>(
    'SELECT signin_sha256s FROM ONLY kg_config:signin'
  );
  return row?.signin_sha256s ?? null;
}

describe('publishSigninSecret', () => {
  let skipTests = false;

  beforeEach((ctx) => {
    if (skipTests) ctx.skip();
  });

  beforeAll(async () => {
    const conn = await connectTestDb();
    if (!conn) {
      skipTests = true;
      return;
    }
    rootDb = conn;
  });

  beforeEach(async () => {
    if (skipTests) return;
    await rootDb.query('DELETE kg_config:signin');
  });

  afterAll(async () => {
    if (!rootDb) return;
    // Leave the harness state behind: the env secret's hash, as connectTestDb sets it.
    await rootDb.query('UPSERT kg_config:signin SET signin_sha256s = [$hash]', {
      hash: sha256Hex(OWN_SECRET()),
    });
    await rootDb.close();
  });

  it('first boot on an absent row publishes exactly the env secret hash', async () => {
    expect(await allowlist()).toBeNull();
    await publishSigninSecret(FAST);
    expect(await allowlist()).toEqual([sha256Hex(OWN_SECRET())]);
  });

  it('re-boot is idempotent', async () => {
    await publishSigninSecret(FAST);
    await publishSigninSecret(FAST);
    expect(await allowlist()).toEqual([sha256Hex(OWN_SECRET())]);
  });

  it('rejects when only other hashes are present: fast, no retry, no append, row untouched', async () => {
    const foreign = sha256Hex(OTHER_SECRET);
    await rootDb.query('CREATE kg_config:signin SET signin_sha256s = [$h]', { h: foreign });

    let connects = 0;
    await expect(
      publishSigninSecret({
        retryDelaysMs: [50, 50],
        attemptTimeoutMs: 5_000,
        connect: async () => {
          connects++;
          return createRootConnection();
        },
      })
    ).rejects.toBeInstanceOf(SigninSecretNotAcceptedError);
    expect(connects).toBe(1); // a retry would open a second connection
    expect(await allowlist()).toEqual([foreign]);
  });

  it('accepts a list holding the own hash alongside others, without modifying it', async () => {
    const foreign = sha256Hex(OTHER_SECRET);
    const own = sha256Hex(OWN_SECRET());
    await rootDb.query('CREATE kg_config:signin SET signin_sha256s = [$a, $b]', { a: foreign, b: own });
    await publishSigninSecret(FAST);
    expect(await allowlist()).toEqual([foreign, own]);
  });

  it('field assertion rejects uppercase and malformed hashes', async () => {
    await expect(
      rootDb.query('CREATE kg_config:signin SET signin_sha256s = [$h]', { h: sha256Hex(OWN_SECRET()).toUpperCase() })
    ).rejects.toThrow();
    await expect(rootDb.query('CREATE kg_config:signin SET signin_sha256s = ["abc"]')).rejects.toThrow();
    expect(await allowlist()).toBeNull();
  });

  it('concurrent first boots with the same secret both succeed with a single hash', async () => {
    await Promise.all([publishSigninSecret(FAST), publishSigninSecret(FAST)]);
    expect(await allowlist()).toEqual([sha256Hex(OWN_SECRET())]);
  });

  it('concurrent first boots with different secrets: one wins, the other is rejected, the winner is never widened', async () => {
    const results = await Promise.allSettled([
      publishSigninSecret({ ...FAST, secret: OWN_SECRET() }),
      publishSigninSecret({ ...FAST, secret: OTHER_SECRET }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(SigninSecretNotAcceptedError);
    const list = await allowlist();
    expect(list).toHaveLength(1);
    expect([sha256Hex(OWN_SECRET()), sha256Hex(OTHER_SECRET)]).toContain(list![0]);
  });

  it('closes the connection of every attempt', async () => {
    let opened = 0;
    let closed = 0;
    await publishSigninSecret({
      ...FAST,
      connect: async () => {
        opened++;
        const conn = await createRootConnection();
        const close = conn.close.bind(conn);
        conn.close = async () => {
          closed++;
          return close();
        };
        return conn;
      },
    });
    expect(opened).toBeGreaterThan(0);
    expect(closed).toBe(opened);
  });
});
