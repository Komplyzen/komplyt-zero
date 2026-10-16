// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 OR LicenseRef-Komplyzen-Commercial
// Copyright 2024-2026 Komplyzen GmbH. Licensed under the PolyForm Noncommercial License 1.0.0 or a commercial licence from Komplyzen; see LICENSE in this directory.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { createAuthMiddleware } from '../auth.js';
import {
  KgTokenPayload,
  KgDbClient,
  containerCreateSchema,
  containerListQuerySchema,
  containerGrantSchema,
  ContainerErrorCode,
  CONTAINER_ERROR_HTTP_STATUS,
  extractRecordId,
  normalizeRecordId,
  purgeAfter,
} from '../contracts.js';
import { createRateLimiter } from '../rate-limit.js';
import { childLogger } from '../logger.js';

const logger = childLogger('container-routes');

type RouteEnv = { Variables: { claims: KgTokenPayload; requestId: string; abortSignal?: AbortSignal } };

interface ContainerRow {
  id: string;
  name: string;
  owner: string;
  tenant: string;
  granted_principals: string[];
  created_at: string;
  deleted_at?: string | null;
  first_deleted_at?: string | null;
}

function containerError(
  c: Context,
  code: ContainerErrorCode,
  message: string
): Response {
  const status = CONTAINER_ERROR_HTTP_STATUS[code] as 400 | 403 | 404 | 409 | 422 | 500 | 503;
  return c.json({ error: { code, message } }, status);
}

export function createContainerRoutes(deps: {
  dbFactory: { createScoped: (claims: KgTokenPayload, signal?: AbortSignal) => Promise<KgDbClient> };
}): Hono<RouteEnv> {
  const { dbFactory } = deps;
  const routes = new Hono<RouteEnv>();

  routes.use('*', createAuthMiddleware());

  routes.use(
    '*',
    createRateLimiter({
      limit: 500,
      windowMs: 60_000,
      keyGenerator: (c) => c.get('claims').tenantId,
    }),
  );

  // POST /containers - Create container (CAP-1)
  routes.post('/', zValidator('json', containerCreateSchema), async (c) => {
    const claims = c.get('claims');
    const params = c.req.valid('json');
    const db = await dbFactory.createScoped(claims, c.get('abortSignal'));

    try {
      const ownerPrincipal = params.owner ?? `principal:user_${claims.sub}`;

      const created = await db.queryOne<ContainerRow>(
        `CREATE container SET
          name = $name,
          tenant = type::record('tenant', $tenant_id),
          owner = type::record('principal', $owner_id),
          granted_principals = [type::record('principal', $owner_id)],
          created_at = time::now()
        RETURN id, name, owner, tenant, granted_principals, created_at`,
        {
          name: params.name,
          tenant_id: claims.tenantId,
          owner_id: extractRecordId(ownerPrincipal, 'principal'),
        }
      );

      if (!created) {
        return containerError(c, ContainerErrorCode.INTERNAL, 'Failed to create container');
      }

      return c.json({
        id: normalizeRecordId(created.id),
        name: created.name,
        owner: normalizeRecordId(created.owner),
        tenant: normalizeRecordId(created.tenant),
        granted_principals: created.granted_principals.map(p => normalizeRecordId(p)),
        created_at: created.created_at,
      }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : undefined;
      if (message?.includes('already exists') || message?.includes('unique')) {
        return containerError(c, ContainerErrorCode.CONFLICT, `Container name '${params.name}' already exists in tenant`);
      }
      logger.error({ err, tenantId: claims.tenantId }, 'Container create failed');
      return containerError(c, ContainerErrorCode.INTERNAL, 'Failed to create container');
    } finally {
      await db.close();
    }
  });

  // GET /containers - List containers (CAP-4)
  routes.get('/', zValidator('query', containerListQuerySchema), async (c) => {
    const claims = c.get('claims');
    const query = c.req.valid('query');
    const db = await dbFactory.createScoped(claims, c.get('abortSignal'));

    try {
      const deletedFilter = query.include_deleted ? '' : 'AND deleted_at IS NONE';
      const cursorFilter = query.cursor
        ? `AND created_at < type::datetime($cursor)`
        : '';

      const containers = await db.query<ContainerRow>(
        `SELECT id, name, owner, granted_principals, created_at, deleted_at
         FROM container
         WHERE tenant = type::record('tenant', $tenant_id)
         ${deletedFilter}
         ${cursorFilter}
         ORDER BY created_at DESC
         LIMIT $limit`,
        {
          tenant_id: claims.tenantId,
          cursor: query.cursor,
          limit: query.limit + 1,
        }
      );

      const hasMore = containers.length > query.limit;
      const items = hasMore ? containers.slice(0, query.limit) : containers;
      const nextCursor = hasMore ? items[items.length - 1].created_at : null;

      return c.json({
        containers: items.map(cont => ({
          id: normalizeRecordId(cont.id),
          name: cont.name,
          owner: normalizeRecordId(cont.owner),
          granted_principals: cont.granted_principals.map(p => normalizeRecordId(p)),
          created_at: cont.created_at,
          deleted_at: cont.deleted_at ?? null,
        })),
        next_cursor: nextCursor,
      });
    } finally {
      await db.close();
    }
  });

  // GET /containers/:id - Get container details (CAP-5)
  routes.get('/:id', async (c) => {
    const claims = c.get('claims');
    const containerId = c.req.param('id');
    const db = await dbFactory.createScoped(claims, c.get('abortSignal'));

    try {
      const container = await db.queryOne<ContainerRow>(
        `SELECT id, name, owner, tenant, granted_principals, created_at, deleted_at, first_deleted_at
         FROM type::record('container', $container_id)
         WHERE tenant = type::record('tenant', $tenant_id)`,
        {
          container_id: containerId,
          tenant_id: claims.tenantId,
        }
      );

      if (!container) {
        return containerError(c, ContainerErrorCode.NOT_FOUND, 'Container not found');
      }

      return c.json({
        id: normalizeRecordId(container.id),
        name: container.name,
        owner: normalizeRecordId(container.owner),
        tenant: normalizeRecordId(container.tenant),
        granted_principals: container.granted_principals.map(p => normalizeRecordId(p)),
        created_at: container.created_at,
        deleted_at: container.deleted_at ?? null,
        first_deleted_at: container.first_deleted_at ?? null,
      });
    } finally {
      await db.close();
    }
  });

  // POST /containers/:id/grant - Grant principal access (CAP-2)
  routes.post('/:id/grant', zValidator('json', containerGrantSchema), async (c) => {
    const claims = c.get('claims');
    const containerId = c.req.param('id');
    const { principal } = c.req.valid('json');
    const db = await dbFactory.createScoped(claims, c.get('abortSignal'));

    try {
      const container = await db.queryOne<ContainerRow>(
        `SELECT id, owner, granted_principals
         FROM type::record('container', $container_id)
         WHERE tenant = type::record('tenant', $tenant_id)`,
        {
          container_id: containerId,
          tenant_id: claims.tenantId,
        }
      );

      if (!container) {
        return containerError(c, ContainerErrorCode.NOT_FOUND, 'Container not found');
      }

      const principalId = extractRecordId(principal, 'principal');
      const principalExists = await db.queryOne<{ id: string }>(
        `SELECT id FROM principal WHERE id = type::record('principal', $principal_id)`,
        { principal_id: principalId }
      );

      if (!principalExists) {
        return containerError(c, ContainerErrorCode.UNPROCESSABLE, `Principal '${principal}' not found`);
      }

      const alreadyGranted = container.granted_principals
        .map(p => normalizeRecordId(p))
        .includes(principal);

      if (!alreadyGranted) {
        await db.queryOne(
          `UPDATE type::record('container', $container_id) SET
            granted_principals += type::record('principal', $principal_id)`,
          {
            container_id: containerId,
            principal_id: principalId,
          }
        );

        await db.queryOne(
          `CREATE granted SET
            in = type::record('container', $container_id),
            out = type::record('principal', $principal_id),
            granted_at = time::now(),
            granted_by = $granted_by`,
          {
            container_id: containerId,
            principal_id: principalId,
            granted_by: claims.sub,
          }
        ).catch(err => {
          logger.warn({ err, containerId, principal }, 'Audit trail write failed (best-effort)');
        });
      }

      return c.json({
        granted: true,
        principal,
        container: `container:${containerId}`,
      });
    } finally {
      await db.close();
    }
  });

  // POST /containers/:id/revoke - Revoke principal access (CAP-3)
  routes.post('/:id/revoke', zValidator('json', containerGrantSchema), async (c) => {
    const claims = c.get('claims');
    const containerId = c.req.param('id');
    const { principal } = c.req.valid('json');
    const db = await dbFactory.createScoped(claims, c.get('abortSignal'));

    try {
      const container = await db.queryOne<ContainerRow>(
        `SELECT id, owner, granted_principals
         FROM type::record('container', $container_id)
         WHERE tenant = type::record('tenant', $tenant_id)`,
        {
          container_id: containerId,
          tenant_id: claims.tenantId,
        }
      );

      if (!container) {
        return containerError(c, ContainerErrorCode.NOT_FOUND, 'Container not found');
      }

      if (normalizeRecordId(container.owner) === principal) {
        return containerError(c, ContainerErrorCode.FORBIDDEN, 'Cannot revoke owner access');
      }

      const principalId = extractRecordId(principal, 'principal');
      const isGranted = container.granted_principals
        .map(p => normalizeRecordId(p))
        .includes(principal);

      if (isGranted) {
        await db.queryOne(
          `UPDATE type::record('container', $container_id) SET
            granted_principals -= type::record('principal', $principal_id)`,
          {
            container_id: containerId,
            principal_id: principalId,
          }
        );

        await db.queryOne(
          `DELETE granted WHERE
            in = type::record('container', $container_id) AND
            out = type::record('principal', $principal_id)`,
          {
            container_id: containerId,
            principal_id: principalId,
          }
        ).catch(err => {
          logger.warn({ err, containerId, principal }, 'Audit trail cleanup failed (best-effort)');
        });
      }

      return c.json({
        revoked: true,
        principal,
        container: `container:${containerId}`,
      });
    } finally {
      await db.close();
    }
  });

  // DELETE /containers/:id - Soft-delete container (CAP-6)
  routes.delete('/:id', async (c) => {
    const claims = c.get('claims');
    const containerId = c.req.param('id');
    const db = await dbFactory.createScoped(claims, c.get('abortSignal'));

    try {
      // Default containers CAN be soft-deleted (GDPR erasure support).
      // The 30-day restore window is the safeguard, not a blanket prohibition.

      const container = await db.queryOne<ContainerRow>(
        `SELECT id, deleted_at, first_deleted_at
         FROM type::record('container', $container_id)
         WHERE tenant = type::record('tenant', $tenant_id)`,
        {
          container_id: containerId,
          tenant_id: claims.tenantId,
        }
      );

      if (!container) {
        return containerError(c, ContainerErrorCode.NOT_FOUND, 'Container not found');
      }

      const now = new Date().toISOString();
      const firstDeletedAt = container.first_deleted_at ?? now;

      if (!container.deleted_at) {
        await db.queryOne(
          `UPDATE type::record('container', $container_id) SET
            deleted_at = time::now(),
            first_deleted_at = first_deleted_at ?? time::now()`,
          { container_id: containerId }
        );
      }

      return c.json({
        deleted: true,
        container: `container:${containerId}`,
        deleted_at: now,
        purge_after: purgeAfter(firstDeletedAt),
      });
    } finally {
      await db.close();
    }
  });

  // POST /containers/:id/restore - Restore deleted container (CAP-7)
  routes.post('/:id/restore', async (c) => {
    const claims = c.get('claims');
    const containerId = c.req.param('id');
    const db = await dbFactory.createScoped(claims, c.get('abortSignal'));

    try {
      const container = await db.queryOne<ContainerRow>(
        `SELECT id, deleted_at, first_deleted_at
         FROM type::record('container', $container_id)
         WHERE tenant = type::record('tenant', $tenant_id)`,
        {
          container_id: containerId,
          tenant_id: claims.tenantId,
        }
      );

      if (!container) {
        return containerError(c, ContainerErrorCode.NOT_FOUND, 'Container not found');
      }

      if (container.deleted_at) {
        await db.queryOne(
          `UPDATE type::record('container', $container_id) SET deleted_at = NONE`,
          { container_id: containerId }
        );
      }

      return c.json({
        restored: true,
        container: `container:${containerId}`,
        purge_after: container.first_deleted_at
          ? purgeAfter(container.first_deleted_at)
          : 'never',
      });
    } finally {
      await db.close();
    }
  });

  return routes;
}
