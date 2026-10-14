import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateToken, requireScope, AuthError, buildPrincipals } from './auth.js';
import type { KgTokenPayload } from './contracts.js';

// Mock jose module
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

// Mock env
vi.mock('./env.js', () => ({
  env: {
    KOMPLYT_JWKS_URL: 'https://komplyt.com/.well-known/jwks.json',
    KOMPLYT_ISSUER: 'https://komplyt.com',
    KOMPLYT_AUDIENCE: 'kg-server',
  },
}));

describe('requireScope', () => {
  const baseClaims: KgTokenPayload = {
    sub: 'user:test',
    tenantId: 'tenant-1',
    projects: ['project-1'],
    scope: 'kg:read kg:write',
    principals: ['principal:user_user:test', 'principal:tenant_tenant-1', 'principal:project_project-1'],
    tier: 'free',
  };

  it('passes when scope is present', () => {
    expect(() => requireScope('kg:read', baseClaims)).not.toThrow();
    expect(() => requireScope('kg:write', baseClaims)).not.toThrow();
  });

  it('throws AuthError when scope is missing', () => {
    const readOnlyClaims = { ...baseClaims, scope: 'kg:read' };

    expect(() => requireScope('kg:write', readOnlyClaims)).toThrow(AuthError);
    expect(() => requireScope('kg:write', readOnlyClaims)).toThrow("Scope 'kg:write' required");
  });

  it('returns 403 status code for scope errors', () => {
    const readOnlyClaims = { ...baseClaims, scope: 'kg:read' };

    try {
      requireScope('kg:write', readOnlyClaims);
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).statusCode).toBe(403);
    }
  });
});

describe('validateToken', () => {
  let jwtVerify: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const jose = await import('jose');
    jwtVerify = jose.jwtVerify as ReturnType<typeof vi.fn>;
  });

  it('returns claims for valid Komplyt token', async () => {
    jwtVerify.mockResolvedValueOnce({
      payload: {
        sub: 'user:abc',
        tenantId: 'tenant-1',
        projects: ['project-1', 'project-2'],
        scope: 'kg:read kg:write',
      },
    });

    const claims = await validateToken('valid-token');

    expect(claims).toEqual({
      sub: 'user:abc',
      tenantId: 'tenant-1',
      projects: ['project-1', 'project-2'],
      scope: 'kg:read kg:write',
      principals: [
        'principal:user_user:abc',
        'principal:tenant_tenant-1',
        'principal:project_project-1',
        'principal:project_project-2',
      ],
      tier: 'free',  // defaults to free when not in token
      platformRole: 'member',  // defaults to member when not in token
    });
  });

  it('extracts platformRole admin, collapses unexpected values to member', async () => {
    jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'user:abc', tenantId: 'tenant-1', platformRole: 'admin' },
    });
    expect((await validateToken('t')).platformRole).toBe('admin');

    jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'user:abc', tenantId: 'tenant-1', platformRole: 'superuser' },
    });
    expect((await validateToken('t')).platformRole).toBe('member');
  });

  it('rejects SurrealDB tokens (JWT confusion prevention)', async () => {
    // Need two mock calls since we call validateToken twice
    jwtVerify
      .mockResolvedValueOnce({
        payload: {
          sub: 'user:abc',
          tenantId: 'tenant-1',
          projects: ['project-1'],
          scope: 'kg:read',
          ns: 'kg',  // SurrealDB namespace claim
          db: 'main', // SurrealDB database claim
        },
      })
      .mockResolvedValueOnce({
        payload: {
          sub: 'user:abc',
          tenantId: 'tenant-1',
          projects: ['project-1'],
          scope: 'kg:read',
          ns: 'kg',
          db: 'main',
        },
      });

    await expect(validateToken('surrealdb-token')).rejects.toThrow(AuthError);
    await expect(validateToken('surrealdb-token')).rejects.toThrow('SurrealDB token rejected');
  });

  it('rejects tokens with ac claim (SurrealDB access method)', async () => {
    jwtVerify.mockResolvedValueOnce({
      payload: {
        sub: 'user:abc',
        tenantId: 'tenant-1',
        projects: ['project-1'],
        scope: 'kg:read',
        ac: 'user', // SurrealDB access method
      },
    });

    await expect(validateToken('surrealdb-ac-token')).rejects.toThrow('SurrealDB token rejected');
  });

  it('rejects tokens missing tenantId', async () => {
    jwtVerify.mockResolvedValueOnce({
      payload: {
        sub: 'user:abc',
        projects: ['project-1'],
        scope: 'kg:read',
      },
    });

    await expect(validateToken('no-tenant-token')).rejects.toThrow('Missing or invalid tenantId');
  });

  it('accepts tokens with empty projects array (principals still built)', async () => {
    jwtVerify.mockResolvedValueOnce({
      payload: {
        sub: 'user:abc',
        tenantId: 'tenant-1',
        projects: [],
        scope: 'kg:read',
      },
    });

    const claims = await validateToken('no-projects-token');
    expect(claims.projects).toEqual([]);
    // User with tenantId gets Tenant principal (for read access to company content)
    expect(claims.principals).toEqual([
      'principal:user_user:abc',
      'principal:tenant_tenant-1',
    ]);
  });
});

describe('validateToken notes the tenant tier', () => {
  async function noted(payload: Record<string, unknown>) {
    const { jwtVerify } = await import('jose');
    const tierModule = await import('./tenant-tier.js');
    const spy = vi.spyOn(tierModule, 'noteTenantTier').mockImplementation(() => {});
    (jwtVerify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ payload });
    await validateToken('t');
    const calls = [...spy.mock.calls];
    spy.mockRestore();
    return calls;
  }

  it('hands the tenant and the tier the token CLAIMS to the recorder', async () => {
    expect(await noted({ sub: 'u', tenantId: 'acme', tier: 'team' })).toEqual([['acme', 'team']]);
    expect(await noted({ sub: 'u', tenantId: 'beta', tier: 'enterprise' })).toEqual([['beta', 'enterprise']]);
  });

  // The claims fall back to 'free' for such tokens, but a missing claim says nothing about the plan:
  // recording it would downgrade a paying tenant (and the job would then remove its models).
  it('records nothing when the token has no tier claim', async () => {
    expect(await noted({ sub: 'u', tenantId: 'acme' })).toEqual([]);
  });

  it.each(['platinum', '', 'TEAM', 7, null, { tier: 'team' }])('records nothing for the unusable tier claim %j', async (tier) => {
    expect(await noted({ sub: 'u', tenantId: 'acme', tier })).toEqual([]);
  });

  it('the claims themselves are unchanged: an unknown tier is still free', async () => {
    const { jwtVerify } = await import('jose');
    (jwtVerify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ payload: { sub: 'u', tenantId: 'acme', tier: 'platinum' } });
    expect((await validateToken('t')).tier).toBe('free');
  });

  it('a token that is rejected notes nothing', async () => {
    const { jwtVerify } = await import('jose');
    const tierModule = await import('./tenant-tier.js');
    const spy = vi.spyOn(tierModule, 'noteTenantTier').mockImplementation(() => {});
    (jwtVerify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ payload: { sub: 'u', tier: 'team' } }); // no tenantId
    await expect(validateToken('t')).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('buildPrincipals', () => {
  it('includes User principal for all users', () => {
    const principals = buildPrincipals('user123', null, []);
    expect(principals).toEqual(['principal:user_user123']);
  });

  it('includes Tenant principal when tenantId is provided', () => {
    const principals = buildPrincipals('user123', 'tenant-abc', []);
    expect(principals).toContain('principal:tenant_tenant-abc');
  });

  it('includes Project principals for each project', () => {
    const principals = buildPrincipals('user123', 'tenant-abc', ['proj1', 'proj2']);
    expect(principals).toContain('principal:project_proj1');
    expect(principals).toContain('principal:project_proj2');
  });

  it('builds complete principal set for team user', () => {
    const principals = buildPrincipals('alice', 'acme', ['project-a', 'project-b']);
    expect(principals).toEqual([
      'principal:user_alice',
      'principal:tenant_acme',
      'principal:project_project-a',
      'principal:project_project-b',
    ]);
  });
});

describe('validateToken - scope validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('auto-grants kg:* scopes when missing (Better Auth workaround)', async () => {
    // See auth.ts lines 69-78: tokens without kg:* get them auto-granted
    // This is a temporary workaround for Better Auth not supporting consent-time scope injection
    // TODO: Remove when Better Auth supports consent-time scope injection
    const { jwtVerify } = await import('jose');
    (jwtVerify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      payload: {
        sub: 'user:abc',
        tenantId: 'tenant-1',
        projects: ['project-1'],
        // scope intentionally missing
      },
    });

    const claims = await validateToken('no-scope-token');
    // Should auto-grant kg:read and kg:write
    expect(claims.scope).toContain('kg:read');
    expect(claims.scope).toContain('kg:write');
  });
});
