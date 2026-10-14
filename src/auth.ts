import { createRemoteJWKSet, jwtVerify, errors } from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { KgTokenPayload, ToolScope, SubscriptionTier, PlatformRole } from './contracts.js';
import { principalId } from './contracts.js';
import { noteTenantTier } from './tenant-tier.js';
import { env } from './env.js';
import { childLogger } from './logger.js';
import { getLocalModeClaims } from './auth-local.js';

/**
 * WWW-Authenticate header value for 401 responses.
 * Points MCP clients to the protected resource metadata for OAuth discovery.
 */
export function wwwAuthenticateHeader(publicUrl: string): string {
  return `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"`;
}

const logger = childLogger('auth');

// JWKS with caching (1h cache, 30s cooldown between refresh attempts)
// Lazy-initialized to allow CLI usage without JWKS configured
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!jwks) {
    if (!env.KOMPLYT_JWKS_URL) {
      throw new AuthError('KOMPLYT_JWKS_URL not configured', 500);
    }
    logger.info({ jwksUrl: env.KOMPLYT_JWKS_URL }, 'Initializing JWKS fetcher');

    const options: Parameters<typeof createRemoteJWKSet>[1] = {
      cacheMaxAge: 3600_000,
      cooldownDuration: 30_000,
    };

    // Add Vercel protection bypass header for staging environments
    if (env.VERCEL_BYPASS_SECRET) {
      options.headers = {
        'x-vercel-protection-bypass': env.VERCEL_BYPASS_SECRET,
      };
    }

    jwks = createRemoteJWKSet(new URL(env.KOMPLYT_JWKS_URL), options);
  }
  return jwks;
}

// Track cache staleness for fallback decisions
let lastSuccessfulFetch = Date.now();
const MAX_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

export class AuthError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export async function validateToken(token: string): Promise<KgTokenPayload> {
  // Decode token header to inspect without validation (for debugging)
  const parts = token.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      logger.debug({
        iss: payload.iss,
        aud: payload.aud,
        sub: payload.sub,
        exp: payload.exp,
        expectedIss: env.KOMPLYT_ISSUER,
        expectedAud: env.KOMPLYT_AUDIENCE,
      }, 'Token claims before validation');
    } catch {
      // Ignore decode errors, validation will catch them
    }
  }

  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: env.KOMPLYT_ISSUER,
      audience: env.KOMPLYT_AUDIENCE,
    });

    lastSuccessfulFetch = Date.now();

    // JWT confusion prevention: reject SurrealDB tokens
    if (payload.ns || payload.db || payload.ac) {
      throw new AuthError('Invalid token type: SurrealDB token rejected', 401);
    }

    // Require tenantId claim
    if (!payload.tenantId || typeof payload.tenantId !== 'string') {
      throw new AuthError('Missing or invalid tenantId claim', 401);
    }

    // Projects claim is optional — empty means "all projects in tenant"
    // TODO: implement proper KG-managed project access control
    const projects = Array.isArray(payload.projects) ? payload.projects as string[] : [];

    // sub is the user ID for authorization_code flow, or client_id (azp) for client_credentials
    const sub = (payload.sub || payload.azp) as string;
    if (!sub) {
      throw new AuthError('Missing subject claim (sub or azp)', 401);
    }
    const tenantId = payload.tenantId as string;

    // Grant implicit kg:read kg:write for valid Komplyt users
    // Better Auth doesn't support scope injection at consent time, so ChatGPT tokens
    // arrive without kg:* scopes. We trust the JWT signature + tenantId claim.
    // TODO: Remove when Better Auth supports consent-time scope injection
    let scope = (payload.scope as string) || '';
    if (!scope.includes('kg:read') || !scope.includes('kg:write')) {
      logger.info({ sub, originalScope: scope }, 'Granting implicit kg:* scopes for authenticated user');
      const scopes = new Set(scope.split(' ').filter(Boolean));
      scopes.add('kg:read');
      scopes.add('kg:write');
      scope = Array.from(scopes).join(' ');
    }

    // Extract tier from token, default to 'free' if not present
    // Komplyt uses: free | team | pro (enterprise planned)
    const tier = (payload.tier as SubscriptionTier) || 'free';
    const validTiers: SubscriptionTier[] = ['free', 'team', 'pro', 'enterprise'];
    const normalizedTier = validTiers.includes(tier) ? tier : 'free';

    // Platform role from Komplyt users.role (via buildKGClaimsUncached).
    // Anything other than the exact string 'admin' collapses to 'member' —
    // an unexpected value must never unlock /admin routes.
    const platformRole: PlatformRole = payload.platformRole === 'admin' ? 'admin' : 'member';

    // Bookkeeping for the batch job (which workspaces are licensed); never blocks or fails the request.
    // Only a tier the token actually claims is noted: the fallback to 'free' above says nothing about
    // the plan, and recording it would downgrade a paying tenant.
    const claimedTier = payload.tier;
    if (typeof claimedTier === 'string' && validTiers.includes(claimedTier as SubscriptionTier)) {
      noteTenantTier(tenantId, claimedTier);
    }

    return {
      sub,
      tenantId,
      projects,
      scope,
      principals: buildPrincipals(sub, tenantId, projects),
      tier: normalizedTier,
      platformRole,
    };
  } catch (err) {
    if (err instanceof AuthError) throw err;

    // Handle JWKS fetch failures
    if (err instanceof errors.JWKSNoMatchingKey || err instanceof errors.JWKSTimeout) {
      const staleDuration = Date.now() - lastSuccessfulFetch;
      if (staleDuration > MAX_STALE_MS) {
        logger.error({ staleDuration }, 'JWKS cache too stale, rejecting request');
        throw new AuthError('Authentication service unavailable', 503);
      }
      // Stale cache was used — let it proceed (jose handles this internally)
    }

    if (err instanceof errors.JWTExpired) {
      throw new AuthError('Token expired', 401);
    }

    if (err instanceof errors.JWTClaimValidationFailed) {
      logger.error({ claim: err.claim, reason: err.reason, message: err.message }, 'JWT claim validation failed');
      throw new AuthError(`Token validation failed: ${err.claim} ${err.reason}`, 401);
    }

    logger.error({ err }, 'Token validation failed');
    throw new AuthError('Invalid token', 401);
  }
}

export function requireScope(requiredScope: ToolScope, claims: KgTokenPayload): void {
  const scopes = claims.scope.split(' ');
  if (!scopes.includes(requiredScope)) {
    logger.warn({ requiredScope, actualScopes: scopes, sub: claims.sub }, 'Scope check failed');
    throw new AuthError(`Scope '${requiredScope}' required`, 403);
  }
}

/**
 * Build principals array from user claims.
 * - User principal: always included (personal access)
 * - Tenant principal: included if tenantId present (team users can read company content)
 * - Project principals: included for each project in the projects claim
 */
export function buildPrincipals(
  userId: string,
  tenantId: string | null,
  projects: string[],
): string[] {
  const principals: string[] = [principalId('User', userId)];

  // Tenant principal for any user with a tenantId (team membership)
  // Read-only team users should still see company containers
  if (tenantId && tenantId.length > 0) {
    principals.push(principalId('Tenant', tenantId));
  }

  // Project principals
  for (const projectId of projects) {
    principals.push(principalId('Project', projectId));
  }

  return principals;
}

// Hono middleware factory
export function createAuthMiddleware(): MiddlewareHandler<{
  Variables: { claims: KgTokenPayload };
}> {
  return async (c, next) => {
    // KG_AUTH_MODE=local: one fixed identity, the Authorization header is not looked at.
    const local = getLocalModeClaims();
    if (local) {
      c.set('claims', local);
      return next();
    }

    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      // Include WWW-Authenticate header to trigger OAuth discovery flow
      const publicUrl = env.KG_PUBLIC_URL;
      if (publicUrl) {
        c.res.headers.set('WWW-Authenticate', wwwAuthenticateHeader(publicUrl));
      }
      throw new AuthError('Missing or invalid Authorization header', 401);
    }

    const token = authHeader.slice(7);
    const claims = await validateToken(token);
    c.set('claims', claims);

    await next();
  };
}
