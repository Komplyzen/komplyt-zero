/**
 * Local auth mode (KG_AUTH_MODE=local): no token checking, every request is one fixed
 * user in one fixed tenant. For self-hosting without an identity provider.
 *
 * This only replaces where the claims come from. The `kg_server` database signin and the
 * row-level security run on these claims exactly as they do on a verified Komplyt token, so
 * tenant isolation stays the database's job. Where the server listens and which requests it accepts
 * (loopback bind by default, Host/Origin/Content-Type checks) is local-guard.ts.
 */
import { principalId, type KgTokenPayload } from './contracts.js';
import { env } from './env.js';
import { childLogger } from './logger.js';

const logger = childLogger('auth');

export interface LocalIdentity {
  KG_LOCAL_SUB: string;
  KG_LOCAL_TENANT: string;
}

export function localClaims(identity: LocalIdentity): KgTokenPayload {
  const sub = identity.KG_LOCAL_SUB;
  const tenantId = identity.KG_LOCAL_TENANT;
  return {
    sub,
    tenantId,
    projects: [],
    scope: 'kg:read kg:write',
    // Same shape as buildPrincipals(sub, tenantId, []) in auth.ts (kept free of that import).
    principals: [principalId('User', sub), principalId('Tenant', tenantId)],
    tier: 'free',
    // Never an admin: the /admin routes stay closed even with auth off.
    platformRole: 'member',
  };
}

/** True when KG_AUTH_MODE=local. Hosted-only rules (plan gating) are skipped in this mode. */
export function isLocalAuthMode(): boolean {
  return env.KG_AUTH_MODE === 'local';
}

/** The local identity when KG_AUTH_MODE=local, otherwise null (verify the token as usual). */
export function getLocalModeClaims(): KgTokenPayload | null {
  return isLocalAuthMode() ? localClaims(env) : null;
}

export function localModeWarning(identity: LocalIdentity): string {
  return `auth disabled, every request is ${identity.KG_LOCAL_SUB}@${identity.KG_LOCAL_TENANT}`;
}

/** Logged on every start in local mode, by the HTTP server and the stdio CLI. */
export function logLocalModeWarning(): void {
  if (env.KG_AUTH_MODE === 'local') logger.warn(localModeWarning(env));
}
