/**
 * Migration tracking helper for TypeScript batch migrations.
 *
 * TypeScript migrations must call registerMigration() after completing
 * their work. The CI workflow verifies this registration exists.
 *
 * Usage:
 *   import { registerMigration, createMigrationDb } from '../lib/migration-tracker.js';
 *
 *   const db = await createMigrationDb();
 *   // ... do migration work ...
 *   await registerMigration(db, 'migrate-023-some-task.ts');
 *   await db.close();
 */

import { Surreal } from 'surrealdb';
import { env } from '../env.js';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

export async function createMigrationDb(): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(env.KG_DB_URL);
  await db.signin({ username: env.KG_DB_USER, password: env.KG_DB_PASS });
  await db.use({ namespace: env.KG_DB_NS, database: env.KG_DB_NAME });
  return db;
}

export async function registerMigration(
  db: Surreal,
  filename: string,
  appliedBy = 'script'
): Promise<void> {
  const scriptPath = resolve(process.cwd(), 'src/bin', filename);
  let checksum: string;
  try {
    const content = readFileSync(scriptPath, 'utf-8');
    checksum = createHash('sha256').update(content).digest('hex');
  } catch {
    checksum = 'COMPUTED_AT_RUNTIME';
  }

  await db.query(
    `INSERT INTO _migrations { filename: $filename, checksum: $checksum, applied_by: $applied_by }`,
    { filename, checksum, applied_by: appliedBy }
  );
}

export async function isMigrationApplied(db: Surreal, filename: string): Promise<boolean> {
  const result = await db.query<[{ filename: string }[]]>(
    `SELECT filename FROM _migrations WHERE filename = $filename`,
    { filename }
  );
  return result[0]?.length > 0;
}
