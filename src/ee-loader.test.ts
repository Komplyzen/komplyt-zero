import { describe, it, expect } from 'vitest';
import {
  loadEnterpriseModules,
  isMissingEeIndex,
  EnterpriseModulesMissingError,
} from './ee-loader.js';

function moduleNotFound(message: string): Error {
  return Object.assign(new Error(message), { code: 'ERR_MODULE_NOT_FOUND' });
}

// Message shapes as Bun and Node report a missing ./ee/index.js.
const MISSING_EE_BUN = moduleNotFound("Cannot find module './ee/index.js' imported from /app/src/index.ts");
const MISSING_EE_NODE = moduleNotFound("Cannot find module '/app/src/ee/index.js' imported from /app/src/index.ts");

describe('isMissingEeIndex', () => {
  it('recognises a missing ee/index.js from Bun and Node', () => {
    expect(isMissingEeIndex(MISSING_EE_BUN)).toBe(true);
    expect(isMissingEeIndex(MISSING_EE_NODE)).toBe(true);
  });

  it('does not treat a dependency missing inside ee/ as an absent ee/', () => {
    const err = moduleNotFound("Cannot find package 'some-oauth-lib' imported from /app/src/ee/oauth.ts");
    expect(isMissingEeIndex(err)).toBe(false);
  });

  it('does not treat other errors as an absent ee/', () => {
    expect(isMissingEeIndex(new SyntaxError("Unexpected token in /app/src/ee/index.js"))).toBe(false);
    expect(isMissingEeIndex('ee/index.js')).toBe(false);
  });
});

describe('loadEnterpriseModules', () => {
  it('returns the module when ee/ loads', async () => {
    const mod = { createOAuthRoutes: () => 'oauth' };
    expect(await loadEnterpriseModules(async () => mod, true)).toBe(mod);
  });

  it('returns undefined (open-source edition) when ee/ is absent and not required', async () => {
    await expect(loadEnterpriseModules(async () => { throw MISSING_EE_BUN; }, false)).resolves.toBeUndefined();
  });

  it('refuses to start when ee/ is absent but required', async () => {
    await expect(loadEnterpriseModules(async () => { throw MISSING_EE_BUN; }, true)).rejects.toBeInstanceOf(
      EnterpriseModulesMissingError
    );
  });

  it('propagates any other load failure, required or not', async () => {
    const boom = new Error('ee init failed');
    await expect(loadEnterpriseModules(async () => { throw boom; }, false)).rejects.toBe(boom);
    await expect(loadEnterpriseModules(async () => { throw boom; }, true)).rejects.toBe(boom);
  });
});
