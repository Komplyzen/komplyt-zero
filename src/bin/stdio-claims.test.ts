import { describe, it, expect, vi } from 'vitest';
import type { KgTokenPayload } from '../contracts.js';
import { prepareStdioAuth, resolveStdioClaims } from './stdio-claims.js';

const fromCredentials: KgTokenPayload = {
  sub: 'user-1',
  tenantId: 'tenant-1',
  projects: [],
  scope: 'kg:read kg:write',
  principals: ['principal:user_user-1', 'principal:tenant_tenant-1'],
  tier: 'team',
};

describe('resolveStdioClaims', () => {
  it('local mode: the fixed local identity, and the credentials are never read', async () => {
    const load = vi.fn().mockRejectedValue(new Error('No credentials found. Run `kg auth login`'));
    const claims = await resolveStdioClaims(
      { KG_AUTH_MODE: 'local', KG_LOCAL_SUB: 'ada', KG_LOCAL_TENANT: 'lab-1' },
      load
    );
    expect(claims).toMatchObject({
      sub: 'ada',
      tenantId: 'lab-1',
      scope: 'kg:read kg:write',
      tier: 'free',
    });
    expect(claims.platformRole).toBe('member');
    expect(load).not.toHaveBeenCalled();
  });

  it('komplyt mode: whatever the stored credentials say, unchanged', async () => {
    const load = vi.fn().mockResolvedValue(fromCredentials);
    const claims = await resolveStdioClaims(
      {
        KG_AUTH_MODE: 'komplyt',
        KG_LOCAL_SUB: 'local',
        KG_LOCAL_TENANT: 'local',
      },
      load
    );
    expect(claims).toBe(fromCredentials);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('komplyt mode: a missing login still fails with the login hint', async () => {
    const load = vi
      .fn()
      .mockRejectedValue(new Error('No credentials found. Run `kg auth login` to authenticate.'));
    await expect(
      resolveStdioClaims(
        {
          KG_AUTH_MODE: 'komplyt',
          KG_LOCAL_SUB: 'local',
          KG_LOCAL_TENANT: 'local',
        },
        load
      )
    ).rejects.toThrow(/kg auth login/);
  });
});

describe('prepareStdioAuth', () => {
  const ids = { KG_LOCAL_SUB: 'local', KG_LOCAL_TENANT: 'local' };

  it('local mode: warns, then publishes the signin secret once', async () => {
    const order: string[] = [];
    await prepareStdioAuth(
      { KG_AUTH_MODE: 'local', ...ids },
      {
        warn: () => order.push('warn'),
        publish: async () => void order.push('publish'),
      }
    );
    expect(order).toEqual(['warn', 'publish']);
  });

  it('komplyt mode: neither warns nor publishes (an end-user machine must not allowlist its own secret)', async () => {
    const warn = vi.fn();
    const publish = vi.fn();
    await prepareStdioAuth({ KG_AUTH_MODE: 'komplyt', ...ids }, { warn, publish });
    expect(warn).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('a failing publish stops startup (local mode)', async () => {
    await expect(
      prepareStdioAuth(
        { KG_AUTH_MODE: 'local', ...ids },
        {
          warn: () => {},
          publish: async () => Promise.reject(new Error('allowlist rejected')),
        }
      )
    ).rejects.toThrow('allowlist rejected');
  });
});
