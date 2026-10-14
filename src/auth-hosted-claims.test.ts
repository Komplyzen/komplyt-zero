/**
 * Characterisation of what hosted production hands the tools for a Komplyt token.
 *
 * Local auth mode must not change any of this. This file mocks the environment exactly as
 * auth.test.ts does (no KG_AUTH_MODE at all) and must pass unchanged before and after the
 * local-mode work: validateToken stays the only komplyt-mode verifier.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateToken } from './auth.js';

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
  errors: {
    JWKSNoMatchingKey: class JWKSNoMatchingKey extends Error {},
    JWKSTimeout: class JWKSTimeout extends Error {},
    JWTExpired: class JWTExpired extends Error {},
    JWTClaimValidationFailed: class JWTClaimValidationFailed extends Error {},
  },
}));

vi.mock('./env.js', () => ({
  env: {
    KOMPLYT_JWKS_URL: 'https://komplyt.com/.well-known/jwks.json',
    KOMPLYT_ISSUER: 'https://komplyt.com',
    KOMPLYT_AUDIENCE: 'kg-server',
  },
}));

async function verifyAs(payload: Record<string, unknown>) {
  const { jwtVerify } = await import('jose');
  (jwtVerify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ payload });
  return validateToken('token');
}

describe('hosted claims for a Komplyt token', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a token without scope gets exactly "kg:read kg:write", tier free, role member', async () => {
    expect(await verifyAs({ sub: 'u1', tenantId: 't1' })).toEqual({
      sub: 'u1',
      tenantId: 't1',
      projects: [],
      scope: 'kg:read kg:write',
      principals: ['principal:user_u1', 'principal:tenant_t1'],
      tier: 'free',
      platformRole: 'member',
    });
  });

  it('foreign scopes are kept, and the implicit grant is appended after them', async () => {
    const claims = await verifyAs({ sub: 'u1', tenantId: 't1', scope: 'openid profile' });
    expect(claims.scope).toBe('openid profile kg:read kg:write');
  });

  it('a token that already has kg:read only still gets kg:write added', async () => {
    const claims = await verifyAs({ sub: 'u1', tenantId: 't1', scope: 'kg:read' });
    expect(claims.scope).toBe('kg:read kg:write');
  });

  it.each(['free', 'team', 'pro', 'enterprise'])('keeps the %s tier', async (tier) => {
    expect((await verifyAs({ sub: 'u1', tenantId: 't1', tier })).tier).toBe(tier);
  });

  it('collapses an unknown tier to free', async () => {
    expect((await verifyAs({ sub: 'u1', tenantId: 't1', tier: 'platinum' })).tier).toBe('free');
  });

  it('uses azp as the subject for client-credentials tokens', async () => {
    const claims = await verifyAs({ azp: 'client-9', tenantId: 't1' });
    expect(claims.sub).toBe('client-9');
    expect(claims.principals).toContain('principal:user_client-9');
  });

  it('platformRole is admin only for the exact string "admin"', async () => {
    expect((await verifyAs({ sub: 'u1', tenantId: 't1', platformRole: 'admin' })).platformRole).toBe('admin');
    expect((await verifyAs({ sub: 'u1', tenantId: 't1', platformRole: 'Admin' })).platformRole).toBe('member');
    expect((await verifyAs({ sub: 'u1', tenantId: 't1', platformRole: true })).platformRole).toBe('member');
  });
});
