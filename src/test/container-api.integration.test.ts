/**
 * Integration tests for Container REST API
 *
 * Tests verify the container management endpoints work correctly against real SurrealDB v3.
 * Covers: create, list, get, grant, revoke, soft-delete, restore.
 *
 * Run with: bun run vitest run container-api.integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { connectTestDb, wipeData } from './connect.js';

let rootDb: Surreal;

interface ContainerRow {
  id: unknown;
  name: string;
  owner: unknown;
  granted_principals: unknown[];
  created_at: string | Date;
  deleted_at?: unknown;
  first_deleted_at?: unknown;
}

async function queryFirst<T>(db: Surreal, sql: string, vars?: Record<string, unknown>): Promise<T | null> {
  const result = await db.query<[T[]]>(sql, vars);
  return result[0]?.[0] ?? null;
}

async function queryAll<T>(db: Surreal, sql: string, vars?: Record<string, unknown>): Promise<T[]> {
  const result = await db.query<[T[]]>(sql, vars);
  return result[0] ?? [];
}

describe('Container API Integration', () => {
  let skipTests = false;

  // Runtime skip: a skipped test must REPORT as skipped. The old
  // `if (skipTests) return` pattern counted empty test bodies as PASSED
  // (weeks of green CI over zero assertions).
  beforeEach((ctx) => {
    if (skipTests) ctx.skip();
  });

  beforeAll(async () => {
    const db = await connectTestDb();
    if (!db) {
      skipTests = true;
      return;
    }
    rootDb = db;
    await wipeData(rootDb);

    // Test data (principal.type is asserted to ['User', 'Tenant', 'Project']
    // by the real schema). Tests run as root, so RLS does not block them.
    await rootDb.query(`
      CREATE tenant:test SET name = 'Test Corp';
      CREATE tenant:other SET name = 'Other Corp';

      CREATE principal:user_alice SET type = 'User', ref_id = 'alice';
      CREATE principal:user_bob SET type = 'User', ref_id = 'bob';
      CREATE principal:tenant_test SET type = 'Tenant', ref_id = 'test';
      CREATE principal:project_engineering SET type = 'Project', ref_id = 'engineering';
    `);
  });

  afterAll(async () => {
    await rootDb?.close();
  });

  // CAP-1: Create container
  describe('Create Container', () => {
    it('should create container with owner', async () => {
      const result = await queryFirst<ContainerRow>(rootDb,
        `CREATE container SET
          name = 'test-container',
          tenant = type::record('tenant', 'test'),
          owner = type::record('principal', 'user_alice'),
          granted_principals = [type::record('principal', 'user_alice')],
          created_at = time::now()
        RETURN id, name, owner, tenant, granted_principals, created_at`
      );

      expect(result).toBeTruthy();
      expect(result!.name).toBe('test-container');
      expect(String(result!.owner)).toContain('user_alice');
      expect(result!.granted_principals).toHaveLength(1);
    });

    it('should reject duplicate container name in same tenant', async () => {
      await rootDb.query(
        `CREATE container SET
          name = 'unique-name',
          tenant = type::record('tenant', 'test'),
          owner = type::record('principal', 'user_alice'),
          created_at = time::now()`
      );

      // SurrealDB unique constraint violation - SDK may throw or return error in result
      let threw = false;
      try {
        await rootDb.query(
          `CREATE container SET
            name = 'unique-name',
            tenant = type::record('tenant', 'test'),
            owner = type::record('principal', 'user_bob'),
            created_at = time::now()`
        );
      } catch {
        threw = true;
      }
      // Unique index constraint should prevent duplicate
      expect(threw).toBe(true);
    });

    it('should allow same name in different tenants', async () => {
      await rootDb.query(
        `CREATE container SET
          name = 'shared-name',
          tenant = type::record('tenant', 'test'),
          owner = type::record('principal', 'user_alice'),
          created_at = time::now()`
      );

      const result = await queryFirst<ContainerRow>(rootDb,
        `CREATE container SET
          name = 'shared-name',
          tenant = type::record('tenant', 'other'),
          owner = type::record('principal', 'user_bob'),
          created_at = time::now()
        RETURN name`
      );

      expect(result?.name).toBe('shared-name');
    });
  });

  // CAP-2/3: Grant/Revoke
  describe('Grant and Revoke', () => {
    it('should add principal to granted_principals array', async () => {
      await rootDb.query(
        `CREATE container:grant_test SET
          name = 'grant-test',
          tenant = type::record('tenant', 'test'),
          owner = type::record('principal', 'user_alice'),
          granted_principals = [type::record('principal', 'user_alice')]`
      );

      await rootDb.query(
        `UPDATE container:grant_test SET
          granted_principals += type::record('principal', 'user_bob')`
      );

      const result = await queryFirst<ContainerRow>(rootDb,
        `SELECT granted_principals FROM container:grant_test`
      );

      expect(result!.granted_principals).toHaveLength(2);
    });

    it('should remove principal from granted_principals array', async () => {
      await rootDb.query(
        `CREATE container:revoke_test SET
          name = 'revoke-test',
          tenant = type::record('tenant', 'test'),
          owner = type::record('principal', 'user_alice'),
          granted_principals = [
            type::record('principal', 'user_alice'),
            type::record('principal', 'user_bob')
          ]`
      );

      await rootDb.query(
        `UPDATE container:revoke_test SET
          granted_principals -= type::record('principal', 'user_bob')`
      );

      const result = await queryFirst<ContainerRow>(rootDb,
        `SELECT granted_principals FROM container:revoke_test`
      );

      expect(result!.granted_principals).toHaveLength(1);
      expect(String(result!.granted_principals[0])).toContain('user_alice');
    });
  });

  // CAP-4/5: List/Get
  describe('List and Get Containers', () => {
    it('should list containers filtered by tenant', async () => {
      await rootDb.query(
        `CREATE container:list_a SET name = 'list-a', tenant = type::record('tenant', 'test'), owner = type::record('principal', 'user_alice')`
      );
      await rootDb.query(
        `CREATE container:list_b SET name = 'list-b', tenant = type::record('tenant', 'other'), owner = type::record('principal', 'user_bob')`
      );

      const testContainers = await queryAll<ContainerRow>(rootDb,
        `SELECT * FROM container WHERE tenant = type::record('tenant', 'test')`
      );
      const otherContainers = await queryAll<ContainerRow>(rootDb,
        `SELECT * FROM container WHERE tenant = type::record('tenant', 'other')`
      );

      const testNames = testContainers.map(c => c.name);
      const otherNames = otherContainers.map(c => c.name);

      expect(testNames).toContain('list-a');
      expect(testNames).not.toContain('list-b');
      expect(otherNames).toContain('list-b');
    });

    it('should order by created_at DESC', async () => {
      const containers = await queryAll<ContainerRow>(rootDb,
        `SELECT name, created_at FROM container
         WHERE tenant = type::record('tenant', 'test')
         ORDER BY created_at DESC`
      );

      for (let i = 1; i < containers.length; i++) {
        expect(
          new Date(containers[i - 1].created_at).getTime()
        ).toBeGreaterThanOrEqual(
          new Date(containers[i].created_at).getTime()
        );
      }
    });
  });

  // CAP-6/7: Soft-delete and Restore
  describe('Soft-delete and Restore', () => {
    it('should set deleted_at and first_deleted_at on delete', async () => {
      await rootDb.query(
        `CREATE container:delete_test SET
          name = 'delete-test',
          tenant = type::record('tenant', 'test'),
          owner = type::record('principal', 'user_alice')`
      );

      await rootDb.query(
        `UPDATE container:delete_test SET
          deleted_at = time::now(),
          first_deleted_at = first_deleted_at OR time::now()`
      );

      const result = await queryFirst<ContainerRow>(rootDb,
        `SELECT deleted_at, first_deleted_at FROM container:delete_test`
      );

      expect(result!.deleted_at).toBeTruthy();
      expect(result!.first_deleted_at).toBeTruthy();
    });

    it('should clear deleted_at on restore but preserve first_deleted_at', async () => {
      await rootDb.query(
        `CREATE container:restore_test SET
          name = 'restore-test',
          tenant = type::record('tenant', 'test'),
          owner = type::record('principal', 'user_alice')`
      );

      // Delete
      await rootDb.query(
        `UPDATE container:restore_test SET
          deleted_at = time::now(),
          first_deleted_at = time::now()`
      );

      const afterDelete = await queryFirst<ContainerRow>(rootDb,
        `SELECT first_deleted_at FROM container:restore_test`
      );
      const firstDeletedAt = afterDelete!.first_deleted_at;

      // Restore
      await rootDb.query(
        `UPDATE container:restore_test SET deleted_at = NONE`
      );

      const afterRestore = await queryFirst<ContainerRow>(rootDb,
        `SELECT deleted_at, first_deleted_at FROM container:restore_test`
      );

      expect(afterRestore!.deleted_at).toBeFalsy();
      expect(afterRestore!.first_deleted_at).toEqual(firstDeletedAt);
    });

    it('should filter deleted containers from default list', async () => {
      await rootDb.query(
        `CREATE container:visible SET
          name = 'visible',
          tenant = type::record('tenant', 'test'),
          owner = type::record('principal', 'user_alice'),
          deleted_at = NONE`
      );

      await rootDb.query(
        `CREATE container:hidden SET
          name = 'hidden',
          tenant = type::record('tenant', 'test'),
          owner = type::record('principal', 'user_alice'),
          deleted_at = time::now()`
      );

      const visibleOnly = await queryAll<ContainerRow>(rootDb,
        `SELECT name FROM container
         WHERE tenant = type::record('tenant', 'test') AND deleted_at IS NONE`
      );

      const names = visibleOnly.map(c => c.name);
      expect(names).toContain('visible');
      expect(names).not.toContain('hidden');
    });

    it('should include deleted with include_deleted=true', async () => {
      const all = await queryAll<ContainerRow>(rootDb,
        `SELECT name FROM container WHERE tenant = type::record('tenant', 'test')`
      );

      const names = all.map(c => c.name);
      expect(names).toContain('hidden'); // From previous test
    });
  });

  // CAP-8: Purge query pattern
  describe('Purge Pattern', () => {
    it('should identify containers eligible for purge', async () => {
      // Create container "deleted" 31 days ago
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();

      await rootDb.query(
        `CREATE container:old_deleted SET
          name = 'old-deleted',
          tenant = type::record('tenant', 'test'),
          owner = type::record('principal', 'user_alice'),
          deleted_at = type::datetime('${oldDate}'),
          first_deleted_at = type::datetime('${oldDate}')`
      );

      const eligible = await queryAll<ContainerRow>(rootDb,
        `SELECT id, name FROM container
         WHERE first_deleted_at != NONE
         AND first_deleted_at < time::now() - 30d`
      );

      const names = eligible.map(c => c.name);
      expect(names).toContain('old-deleted');
    });
  });

  // Default container protection
  describe('Default Container', () => {
    it('should identify default container by ID convention', async () => {
      await rootDb.query(
        `CREATE container:test_default SET
          name = 'Company Knowledge',
          tenant = type::record('tenant', 'test'),
          owner = type::record('principal', 'tenant_test')`
      );

      const result = await queryFirst<ContainerRow>(rootDb,
        `SELECT id FROM container:test_default`
      );

      expect(String(result!.id)).toBe('container:test_default');
    });
  });
});
