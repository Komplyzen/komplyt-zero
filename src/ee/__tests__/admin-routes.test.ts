// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 OR LicenseRef-Komplyzen-Commercial
// Copyright 2024-2026 Komplyzen GmbH. Licensed under the PolyForm Noncommercial License 1.0.0 or a commercial licence from Komplyzen; see LICENSE in this directory.

/**
 * Unit tests for /admin route gates.
 *
 * HTTP-surface behavior only — auth gates, enumeration-safety, reason
 * validation, rate limiting — with fake claims and a stub connection.
 * The DB semantics (cascade, atomicity, audit) are covered by
 * test/container-purge.integration.test.ts against real SurrealDB.
 */

import { describe, it, expect, vi } from 'vitest';
import type { MiddlewareHandler } from 'hono';
import type { Surreal } from 'surrealdb';

// Mock env (convention from auth.test.ts): admin-routes imports auth.ts,
// whose module graph validates the full server env on import. These tests
// inject a fake authMiddleware, so no env value is ever actually read —
// the mock only has to satisfy the import.
vi.mock('../../env.js', () => ({ env: {} }));

import { createAdminRoutes } from '../admin-routes.js';
import type { KgTokenPayload, PlatformRole } from '../../contracts.js';

const SECRET = 'test-purge-secret-with-32-chars-min!';

function fakeAuth(sub: string, platformRole: PlatformRole): MiddlewareHandler {
  return async (c, next) => {
    const claims: KgTokenPayload = {
      sub,
      tenantId: 'staff-tenant',
      projects: [],
      scope: 'kg:read kg:write',
      principals: [],
      tier: 'free',
      platformRole,
    };
    c.set('claims', claims);
    await next();
  };
}

/** Stub Surreal whose query() resolves with the given per-call results */
function stubDb(queryResult: unknown = []): Surreal {
  return {
    query: async () => queryResult,
    close: async () => {},
  } as unknown as Surreal;
}

const VALID_BODY = JSON.stringify({ reason: 'GDPR request #1234' });
const JSON_HEADERS = { 'Content-Type': 'application/json' };

describe('POST /purge (CAP-1 gate)', () => {
  it('404s when no secret is configured, even with a bearer token', async () => {
    const app = createAdminRoutes({ createRootConnection: async () => stubDb() });
    const res = await app.request('/purge', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(404);
  });

  it('404s on missing Authorization header', async () => {
    const app = createAdminRoutes({
      createRootConnection: async () => stubDb(),
      purgeJobSecret: SECRET,
    });
    const res = await app.request('/purge', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('404s on wrong secret', async () => {
    const app = createAdminRoutes({
      createRootConnection: async () => stubDb(),
      purgeJobSecret: SECRET,
    });
    const res = await app.request('/purge', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-secret-that-is-long-enough!!' },
    });
    expect(res.status).toBe(404);
  });

  it('runs the purge and reports the heartbeat shape on correct secret', async () => {
    const app = createAdminRoutes({
      createRootConnection: async () => stubDb([]), // no eligible containers
      purgeJobSecret: SECRET,
    });
    const res = await app.request('/purge', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eligible: 0, purged: [], skipped: [], failures: [] });
  });

  it('returns 500 with failures[] when a per-container purge fails — the GH job failure trigger', async () => {
    // First query = eligibility select (one row); second = the purge
    // transaction, which blows up.
    let call = 0;
    const db = {
      query: async () => {
        call += 1;
        if (call === 1) return [[{ id: 'container:doomed', tenant: 'tenant:t1' }]];
        throw new Error('transaction exploded');
      },
      close: async () => {},
    } as unknown as Surreal;

    const app = createAdminRoutes({
      createRootConnection: async () => db,
      purgeJobSecret: SECRET,
    });
    const res = await app.request('/purge', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0].container).toBe('doomed');
  });
});

describe('DELETE /tenants/:tenantId/containers/:containerId (CAP-2 gate)', () => {
  const path = '/tenants/tenant-x/containers/container-y';

  it('404s for non-admin callers — even with an invalid body (no existence oracle)', async () => {
    const app = createAdminRoutes({
      createRootConnection: async () => stubDb(),
      authMiddleware: fakeAuth('member-1', 'member'),
    });
    const res = await app.request(path, {
      method: 'DELETE',
      headers: JSON_HEADERS,
      body: JSON.stringify({ nonsense: true }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('400s when the reason is missing', async () => {
    const app = createAdminRoutes({
      createRootConnection: async () => stubDb(),
      authMiddleware: fakeAuth('admin-1', 'admin'),
    });
    const res = await app.request(path, {
      method: 'DELETE',
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('400s when the reason is under 10 chars after trimming', async () => {
    const app = createAdminRoutes({
      createRootConnection: async () => stubDb(),
      authMiddleware: fakeAuth('admin-2', 'admin'),
    });
    const res = await app.request(path, {
      method: 'DELETE',
      headers: JSON_HEADERS,
      body: JSON.stringify({ reason: '   x        ' }),
    });
    expect(res.status).toBe(400);
  });

  it('404s when the container is not in the target tenant', async () => {
    const app = createAdminRoutes({
      // sentinel shape: transaction returns { found: false } for a miss
      createRootConnection: async () => stubDb([null, { found: false }]),
      authMiddleware: fakeAuth('admin-3', 'admin'),
    });
    const res = await app.request(path, {
      method: 'DELETE',
      headers: JSON_HEADERS,
      body: VALID_BODY,
    });
    expect(res.status).toBe(404);
  });

  it('soft-deletes with a valid reason and returns audit id + purge_after', async () => {
    const firstDeleted = new Date().toISOString();
    const app = createAdminRoutes({
      createRootConnection: async () =>
        stubDb([
          null,
          { found: true, deleted_at: firstDeleted, first_deleted_at: firstDeleted, audit_id: 'audit123' },
          null,
        ]),
      authMiddleware: fakeAuth('admin-4', 'admin'),
    });
    const res = await app.request(path, {
      method: 'DELETE',
      headers: JSON_HEADERS,
      body: VALID_BODY,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    expect(body.container).toBe('container:container-y');
    expect(body.tenant).toBe('tenant:tenant-x');
    expect(body.audit_id).toBe('audit123');
    const expectedPurgeAfter = new Date(firstDeleted).getTime() + 30 * 24 * 60 * 60 * 1000;
    expect(new Date(body.purge_after).getTime()).toBe(expectedPurgeAfter);
  });

  it('rate-limits an admin after 10 deletes per hour', async () => {
    const firstDeleted = new Date().toISOString();
    const app = createAdminRoutes({
      createRootConnection: async () =>
        stubDb([
          null,
          { found: true, deleted_at: firstDeleted, first_deleted_at: firstDeleted, audit_id: 'a' },
          null,
        ]),
      authMiddleware: fakeAuth('admin-rate-limit-unique', 'admin'),
    });

    for (let i = 0; i < 10; i++) {
      const res = await app.request(path, {
        method: 'DELETE',
        headers: JSON_HEADERS,
        body: VALID_BODY,
      });
      expect(res.status).toBe(200);
    }
    const eleventh = await app.request(path, {
      method: 'DELETE',
      headers: JSON_HEADERS,
      body: VALID_BODY,
    });
    expect(eleventh.status).toBe(429);

    // Per admin user: another admin's budget is untouched by the first one's 429
    const otherAdmin = createAdminRoutes({
      createRootConnection: async () =>
        stubDb([
          null,
          { found: true, deleted_at: firstDeleted, first_deleted_at: firstDeleted, audit_id: 'b' },
          null,
        ]),
      authMiddleware: fakeAuth('admin-rate-limit-other', 'admin'),
    });
    const otherRes = await otherAdmin.request(path, {
      method: 'DELETE',
      headers: JSON_HEADERS,
      body: VALID_BODY,
    });
    expect(otherRes.status).toBe(200);
  });
});
