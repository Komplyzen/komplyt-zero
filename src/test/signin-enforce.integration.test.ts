/**
 * Integration tests for the enforced signin allowlist: kg_server SIGNIN only succeeds when
 * sha256($secret) is in kg_config:signin.signin_sha256s. Runs against the
 * real migrations; on a database without the enforcement the rejection tests fail,
 * which is the point (they are the regression guard for the signin allowlist).
 *
 * Run with: bun run vitest run signin-enforce.integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Surreal } from 'surrealdb';
import { connectTestDb } from './connect.js';
import { sha256Hex } from '../signin-secret.js';
import { getEnv } from '../env.js';

const OWN_SECRET = () => getEnv().KG_JWT_SECRET;
const OTHER_SECRET = 'a-different-secret-that-is-32-chars-long!';
const TENANT = 'signin-enforce-tenant';

let rootDb: Surreal;

async function setAllowlist(hashes: string[]): Promise<void> {
  await rootDb.query('UPSERT kg_config:signin SET signin_sha256s = $hashes', { hashes });
}

async function sessionCount(): Promise<number> {
  const [rows] = await rootDb.query<[{ n: number }[]]>(
    'SELECT count() AS n FROM kg_auth_session WHERE tenantId = $tenant GROUP ALL',
    { tenant: TENANT }
  );
  return rows[0]?.n ?? 0;
}

/** Sign in through kg_server exactly as dbFactory.createScoped does, with a chosen secret. */
async function signinWith(variables: Record<string, unknown>): Promise<Surreal> {
  const env = getEnv();
  const db = new Surreal();
  await db.connect(env.KG_DB_URL);
  try {
    await db.signin({
      namespace: env.KG_DB_NS,
      database: env.KG_DB_NAME,
      access: 'kg_server',
      variables: {
        tenantId: TENANT,
        principals: [`tenant:${TENANT}`],
        sub: 'signin-enforce-test',
        scope: 'kg:read kg:write',
        projects: [],
        ...variables,
      },
    });
  } catch (err) {
    await db.close();
    throw err;
  }
  return db;
}

async function expectRejected(variables: Record<string, unknown>): Promise<void> {
  const before = await sessionCount();
  await expect(signinWith(variables)).rejects.toThrow();
  // A rejected signin must not leave a session row behind.
  expect(await sessionCount()).toBe(before);
}

// Each test does several signins; against the remote CI database that exceeds
// vitest's 5s default.
describe('kg_server SIGNIN enforces the signin-secret allowlist', { timeout: 60_000 }, () => {
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
    await rootDb.query('DELETE kg_auth_session WHERE tenantId = $tenant', { tenant: TENANT });
    await setAllowlist([sha256Hex(OWN_SECRET())]);
  });

  afterAll(async () => {
    if (!rootDb) return;
    // Leave the harness state behind: the env secret's hash, as connectTestDb sets it.
    await setAllowlist([sha256Hex(OWN_SECRET())]);
    await rootDb.query('DELETE kg_auth_session WHERE tenantId = $tenant', { tenant: TENANT });
    await rootDb.close();
  });

  it('accepts the listed secret and creates a session carrying the claims', async () => {
    const db = await signinWith({ secret: OWN_SECRET() });
    try {
      const [rows] = await db.query<[{ tenantId: string }[]]>('SELECT tenantId FROM $auth');
      expect(rows[0]?.tenantId).toBe(TENANT);
    } finally {
      await db.close();
    }
    expect(await sessionCount()).toBe(1);
  });

  it('rejects a secret whose hash is not listed', async () => {
    await expectRejected({ secret: OTHER_SECRET });
  });

  it('rejects a missing, empty or non-string secret', async () => {
    await expectRejected({});
    await expectRejected({ secret: '' });
    await expectRejected({ secret: null });
    await expectRejected({ secret: 12345 });
  });

  it('rejects the listed hash passed as the secret (hash is not a credential)', async () => {
    await expectRejected({ secret: sha256Hex(OWN_SECRET()) });
  });

  it('fails closed when the allowlist row is absent or empty', async () => {
    await rootDb.query('DELETE kg_config:signin');
    await expectRejected({ secret: OWN_SECRET() });

    await setAllowlist([]);
    await expectRejected({ secret: OWN_SECRET() });
  });

  it('accepts every listed secret during a rotation and drops the removed one', async () => {
    await setAllowlist([sha256Hex(OWN_SECRET()), sha256Hex(OTHER_SECRET)]);
    await (await signinWith({ secret: OWN_SECRET() })).close();
    await (await signinWith({ secret: OTHER_SECRET })).close();

    await setAllowlist([sha256Hex(OTHER_SECRET)]);
    await expectRejected({ secret: OWN_SECRET() });
  });

  // SIGNIN reads no $param, so there is nothing to shadow; this guards against
  // a future rewrite that compares against a caller-settable variable.
  it('ignores caller-supplied variables named like the allowlist', async () => {
    const forged = sha256Hex(OTHER_SECRET);
    await expectRejected({ secret: OTHER_SECRET, signin_sha256s: [forged] });
    await expectRejected({ secret: OTHER_SECRET, kg_config: { signin_sha256s: [forged] } });
  });

  it('refuses to list the hash of the empty secret', async () => {
    await expect(setAllowlist([sha256Hex('')])).rejects.toThrow();
    await expect(
      rootDb.query('UPDATE kg_config:signin SET signin_sha256s += $h', { h: sha256Hex('') })
    ).rejects.toThrow();
  });

  it('a signed-in tenant session can neither read nor modify the allowlist', async () => {
    const db = await signinWith({ secret: OWN_SECRET() });
    try {
      const [rows] = await db.query<[unknown[]]>('SELECT * FROM kg_config');
      expect(rows).toEqual([]);
      await db
        .query("UPDATE kg_config:signin SET signin_sha256s += $h", { h: sha256Hex(OTHER_SECRET) })
        .catch(() => undefined);
    } finally {
      await db.close();
    }
    const [row] = await rootDb.query<[{ signin_sha256s: string[] } | null]>(
      'SELECT signin_sha256s FROM ONLY kg_config:signin'
    );
    expect(row?.signin_sha256s).toEqual([sha256Hex(OWN_SECRET())]);
  });
});
