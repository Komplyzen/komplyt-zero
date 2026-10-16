// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 OR LicenseRef-Komplyzen-Commercial
// Copyright 2024-2026 Komplyzen GmbH. Licensed under the PolyForm Noncommercial License 1.0.0 or a commercial licence from Komplyzen; see LICENSE in this directory.

/**
 * /admin routes.
 *
 * Two distinct auth surfaces under one prefix — deliberately NOT one
 * polymorphic admin gate:
 *
 * - POST /admin/purge (CAP-1): machine-to-machine, shared-secret Bearer auth
 *   (PURGE_JOB_SECRET). Called by the scheduled GH Actions workflow. No JWT
 *   path can reach it; if the secret isn't configured the route 404s.
 *
 * - DELETE /admin/tenants/:tenantId/containers/:containerId (CAP-2): human
 *   staff, Komplyt JWT with platformRole 'admin', mandatory reason (≥10 chars
 *   after trim). Soft-delete only — hard deletion only ever happens via CAP-1
 *   after the 30-day window. The audit record (who, whose tenant, which
 *   container, why) is written atomically with the update.
 *
 * Both execute on the server's internal root connection; callers never see
 * DB credentials. Tenant-scoped RLS (`FOR delete NONE`) is untouched.
 */

import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Surreal } from 'surrealdb';
import { createAuthMiddleware } from '../auth.js';
import { adminSoftDelete } from './admin-delete.js';
import {
  KgTokenPayload,
  ContainerErrorCode,
  CONTAINER_ERROR_HTTP_STATUS,
  adminSoftDeleteSchema,
  purgeAfter,
} from '../contracts.js';
import { createRateLimiter } from '../rate-limit.js';
import { runPurge } from './purge.js';
import { childLogger } from '../logger.js';

const logger = childLogger('admin-routes');

type RouteEnv = { Variables: { claims: KgTokenPayload; requestId: string; abortSignal?: AbortSignal } };

function adminError(c: Context, code: ContainerErrorCode, message: string): Response {
  const status = CONTAINER_ERROR_HTTP_STATUS[code] as 400 | 403 | 404 | 409 | 422 | 429 | 500 | 503;
  return c.json({ error: { code, message } }, status);
}

/**
 * Constant-time secret comparison. Hashing first sidesteps
 * timingSafeEqual's equal-length requirement without leaking length.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function createAdminRoutes(deps: {
  createRootConnection: () => Promise<Surreal>;
  purgeJobSecret?: string;
  /** Injectable for tests (fake claims); defaults to real JWT validation */
  authMiddleware?: MiddlewareHandler;
}): Hono<RouteEnv> {
  const { createRootConnection, purgeJobSecret } = deps;
  const authMiddleware = deps.authMiddleware ?? createAuthMiddleware();
  const routes = new Hono<RouteEnv>();

  // ---- CAP-1: purge job trigger (service auth, no JWT) ----
  routes.post('/purge', async (c) => {
    const authHeader = c.req.header('Authorization');
    // Fail closed and enumeration-safe: missing secret config, missing header,
    // and wrong secret are all the same 404 the container API uses elsewhere.
    if (
      !purgeJobSecret ||
      !authHeader?.startsWith('Bearer ') ||
      !secretsMatch(authHeader.slice(7), purgeJobSecret)
    ) {
      return adminError(c, ContainerErrorCode.NOT_FOUND, 'Not found');
    }

    const db = await createRootConnection();
    try {
      const result = await runPurge(db);
      // Any per-container failure fails the run (non-2xx) so the GH Actions
      // job fails and its built-in failure notification fires.
      const status = result.failures.length > 0 ? 500 : 200;
      return c.json(result, status);
    } finally {
      await db.close();
    }
  });

  // ---- CAP-2: admin-initiated soft-delete (staff JWT + reason) ----
  routes.use('/tenants/*', authMiddleware);
  // The platformRole gate runs BEFORE body validation: a non-staff caller
  // gets the container API's uniform 404 regardless of payload shape — the
  // route must not act as an existence oracle (not even via Zod 400s).
  routes.use('/tenants/*', async (c, next) => {
    if (c.get('claims').platformRole !== 'admin') {
      return adminError(c, ContainerErrorCode.NOT_FOUND, 'Container not found');
    }
    await next();
  });
  routes.delete(
    '/tenants/:tenantId/containers/:containerId',
    // Validation BEFORE the rate limiter: malformed requests (400) must not
    // burn the 10/hour budget — otherwise ten typos lock an admin out for an
    // hour without a single delete happening.
    zValidator('json', adminSoftDeleteSchema),
    // Safety net against mistakes or a compromised admin account, not a
    // security boundary. Caveat: the store is per-process,
    // so on Cloud Run the effective limit is 10 × instances, reset on deploy.
    createRateLimiter({
      limit: 10,
      windowMs: 60 * 60 * 1000,
      keyGenerator: (c) => `admin-delete:${c.get('claims').sub}`,
    }),
    async (c) => {
      const claims = c.get('claims');
      const tenantId = c.req.param('tenantId');
      const containerId = c.req.param('containerId');
      const { reason } = c.req.valid('json');

      const db = await createRootConnection();
      try {
        const result = await adminSoftDelete(db, {
          containerId,
          tenantId,
          actor: claims.sub,
          reason,
        });

        if (result === 'not_found') {
          return adminError(c, ContainerErrorCode.NOT_FOUND, 'Container not found');
        }

        const purgeDeadline = purgeAfter(result.first_deleted_at);

        logger.info(
          {
            event: 'admin_soft_delete',
            actor: claims.sub,
            targetTenant: tenantId,
            container: containerId,
            reason,
            auditId: result.audit_id,
          },
          'Admin soft-delete executed'
        );

        return c.json({
          deleted: true,
          container: `container:${containerId}`,
          tenant: `tenant:${tenantId}`,
          deleted_at: result.deleted_at,
          purge_after: purgeDeadline,
          audit_id: result.audit_id,
        });
      } finally {
        await db.close();
      }
    }
  );

  // Any other method/path under /tenants/* from an authenticated admin gets
  // the same JSON 404 shape, not Hono's plain-text default.
  routes.all('/tenants/*', (c) =>
    adminError(c, ContainerErrorCode.NOT_FOUND, 'Container not found')
  );

  return routes;
}
