/**
 * Loads the enterprise modules (src/ee/) when they are present.
 *
 * Only a missing ee/index.js means "open-source edition". Any other failure
 * (a syntax error in ee/, a dependency ee/ imports that is missing, a throw at
 * module init) propagates, so a hosted build never boots silently without
 * OAuth, admin and container routes. Hosted deploys set KG_REQUIRE_EE so that
 * even a missing ee/ is fatal there.
 */

export class EnterpriseModulesMissingError extends Error {
  constructor() {
    super('KG_REQUIRE_EE is set but src/ee/ is not present in this build');
    this.name = 'EnterpriseModulesMissingError';
  }
}

/** True only when the module that could not be found is ee/index.js itself. */
export function isMissingEeIndex(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'ERR_MODULE_NOT_FOUND' && /[\\/]ee[\\/]index\.(js|ts)/.test(err.message);
}

/**
 * Import ee/ via `importEe`. Returns the module, or undefined for the
 * open-source edition. Throws on any other import failure, and on a missing
 * ee/ when `requireEe` is set.
 */
export async function loadEnterpriseModules<T>(
  importEe: () => Promise<T>,
  requireEe: boolean
): Promise<T | undefined> {
  try {
    return await importEe();
  } catch (err) {
    if (!isMissingEeIndex(err)) throw err;
    if (requireEe) throw new EnterpriseModulesMissingError();
    return undefined;
  }
}
