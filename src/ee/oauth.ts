// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 OR LicenseRef-Komplyzen-Commercial
// Copyright 2024-2026 Komplyzen GmbH. Licensed under the PolyForm Noncommercial License 1.0.0 or a commercial licence from Komplyzen; see LICENSE in this directory.

/**
 * OAuth 2.1 discovery metadata for MCP connector clients (Claude.ai, ChatGPT).
 *
 * This module implements RFC 9728 (OAuth Protected Resource Metadata) and
 * RFC 8414 (Authorization Server Metadata) discovery endpoints. The actual
 * OAuth flow (authorize, token, register) is handled by Komplyt; we just
 * point clients there.
 */

import { Hono } from 'hono';
import { env } from '../env.js';
import { childLogger } from '../logger.js';

const logger = childLogger('oauth');

function fallbackMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth2/authorize`,
    token_endpoint: `${issuer}/oauth2/token`,
    registration_endpoint: `${issuer}/oauth2/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
    scopes_supported: ['openid', 'kg:read', 'kg:write'],
  };
}

export function createOAuthRoutes(): Hono {
  const routes = new Hono();

  // GET /.well-known/openai-apps-challenge
  // OpenAI marketplace domain verification
  routes.get('/openai-apps-challenge', (c) => {
    const challenge = env.OPENAI_APPS_CHALLENGE;
    if (!challenge) {
      return c.text('Not Found', 404);
    }
    return c.text(challenge);
  });

  // GET /.well-known/oauth-protected-resource
  // RFC 9728: Protected Resource Metadata
  routes.get('/oauth-protected-resource', (c) => {
    const publicUrl = env.KG_PUBLIC_URL;
    const issuer = env.KOMPLYT_ISSUER;

    if (!publicUrl || !issuer) {
      return c.json({ error: 'KG_PUBLIC_URL and KOMPLYT_ISSUER must be configured' }, 500);
    }

    return c.json({
      resource: `${publicUrl}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: ['kg:read', 'kg:write'],
      resource_name: 'Komplyt Temporal Lobe',
    });
  });

  // GET /.well-known/oauth-authorization-server
  // RFC 8414: Authorization Server Metadata
  // Proxy from Komplyt since Komplyt is the auth server
  routes.get('/oauth-authorization-server', async (c) => {
    const issuer = env.KOMPLYT_ISSUER;
    if (!issuer) {
      return c.json({ error: 'KOMPLYT_ISSUER not configured' }, 500);
    }

    // Extract base URL from issuer (e.g., https://www.kompl.yt/api/auth -> https://www.kompl.yt)
    const issuerUrl = new URL(issuer);
    const baseUrl = `${issuerUrl.protocol}//${issuerUrl.host}`;
    const metadataUrl = `${baseUrl}/.well-known/oauth-authorization-server`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(metadataUrl, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        logger.warn({ metadataUrl, status: response.status }, 'OAuth metadata fetch failed, using fallback');
        return c.json(fallbackMetadata(issuer));
      }

      const metadata = await response.json();
      logger.debug({ metadata }, 'Proxied OAuth metadata from Komplyt');
      return c.json(metadata);
    } catch (err) {
      logger.error({ err, metadataUrl }, 'OAuth metadata fetch error, using fallback');
      return c.json(fallbackMetadata(issuer));
    }
  });

  return routes;
}

// wwwAuthenticateHeader is exported from ../auth.ts (open-source)
