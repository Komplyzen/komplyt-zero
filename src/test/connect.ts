/**
 * Standard test-database access. Nothing here is test-specific setup:
 * tests use the SAME connection factory as the server (createRootConnection,
 * env-driven) against a database that was provisioned by the SAME migration
 * chain as staging/production (migrate-db.yml — in CI via workflow_call into
 * a run-scoped KG_DB_NAME; locally via docker compose + the chain).
 *
 * Suites never create namespaces or databases and never define schema.
 */

import type { Surreal } from 'surrealdb';
import { createRootConnection } from '../db.js';
import { getEnv } from '../env.js';
import { assertAllowlistTableDefined, sha256Hex } from '../signin-secret.js';

/**
 * Connect to the env-configured database. Returns null (suite skips) when
 * the DB is unreachable locally; throws when KG_REQUIRE_DB is set (CI must
 * never pass vacuously) or when pointed at a production-shaped target.
 */
export async function connectTestDb(): Promise<Surreal | null> {
  const env = getEnv();
  // Integration suites wipe tables between tests — allowlist, don't denylist:
  // only names shaped like test targets ('test', 'ci_<run_id>_<attempt>') are
  // accepted, matched exactly (a prefix match would admit 'testing' or
  // 'ci_prod'). A local run accidentally carrying staging/prod credentials
  // must never reach wipeData or the allowlist overwrite below.
  if (!/^(test|ci_[A-Za-z0-9_]+)$/.test(env.KG_DB_NAME)) {
    throw new Error(
      `Integration tests refuse KG_DB_NAME='${env.KG_DB_NAME}'. Only 'test' or 'ci_<run>' databases are accepted — point KG_DB_NAME at a provisioned test database.`
    );
  }
  let db: Surreal;
  try {
    // Fast preflight: the SDK retries a dead host for 10s+ per suite; a 2s
    // health probe keeps the no-DB skip path (e.g. the unit-test CI job) cheap.
    const healthUrl = env.KG_DB_URL.replace(/^ws/, 'http') + '/health';
    const probe = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
    if (!probe.ok) throw new Error(`health probe returned ${probe.status}`);

    db = await createRootConnection();
  } catch (err) {
    if (process.env.KG_REQUIRE_DB) {
      throw new Error(`KG_REQUIRE_DB is set but the database is not usable: ${err}`);
    }
    console.log(`Skipping: SurrealDB not reachable at ${env.KG_DB_URL} (${err})`);
    return null;
  }

  // Keep every suite signing in through the enforced allowlist, even when a
  // stale local database holds another secret's hash. Root-only and guarded
  // by the exact name match above; deliberately separate from the production
  // publish path (which refuses to overwrite). Outside the skip-on-unreachable
  // try on purpose: a reachable database that rejects this (no kg_config table)
  // is misprovisioned and must fail loudly, not skip every suite.
  try {
    // UPSERT alone would auto-create an unconstrained kg_config on a database
    // without the migrations; require the migrated table first.
    await assertAllowlistTableDefined(db);
    await db.query('UPSERT kg_config:signin SET signin_sha256s = [$hash]', {
      hash: sha256Hex(env.KG_JWT_SECRET),
    });
  } catch (err) {
    await db.close();
    throw new Error(`Test database cannot take the signin allowlist (migrations applied?): ${err}`);
  }
  return db;
}

/**
 * Delete all application data (not schema). Suites share one provisioned
 * database and run sequentially — each suite starts from clean data.
 * Order respects references (edges before nodes, etc.); root bypasses RLS.
 */
export async function wipeData(db: Surreal): Promise<void> {
  // On the shared remote CI database a wipe can collide with writes the previous
  // suite left in flight; SurrealDB reports that as a retryable transaction
  // conflict. Retry those, fail on anything else.
  for (let attempt = 1; ; attempt++) {
    try {
      await db.query(
        `DELETE meta_model; DELETE tenant_tier; DELETE training_run; DELETE edge; DELETE decay_event; DELETE node; DELETE granted; DELETE container;
         DELETE session; DELETE principal; DELETE author; DELETE project; DELETE tenant;
         DELETE audit_log; DELETE kg_auth_session;`
      );
      return;
    } catch (err) {
      if (attempt >= 5 || !/can be retried/.test(String(err))) throw err;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}
