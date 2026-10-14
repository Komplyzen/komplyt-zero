/**
 * Authentication-mode environment variables: the Zod fragment
 * env-schema.ts composes into the server schema.
 *
 * `komplyt` (the default) verifies Komplyt-issued JWTs, exactly as hosted
 * production does. `local` turns token checking off and treats every request
 * as one fixed user in one fixed tenant, for self-hosting without an identity
 * provider. The database signin and RLS are the same in both modes.
 */
import { z } from 'zod';
import { blankToUndefined, lowerOrUndefined } from './env-helpers.js';

/**
 * Ids end up inside principal ids ("principal:user_<sub>") that are split on ':'
 * later, and in record ids, so keep them to a boring alphabet.
 */
const localId = z.preprocess(
  blankToUndefined,
  z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, 'letters, digits, "_" and "-" only, at most 64 characters')
    .default('local')
);

export const authEnvShape = {
  KG_AUTH_MODE: z.preprocess(lowerOrUndefined, z.enum(['komplyt', 'local']).default('komplyt')),
  KG_LOCAL_SUB: localId,
  KG_LOCAL_TENANT: localId,
};

interface AuthEnvFields {
  KG_AUTH_MODE: 'komplyt' | 'local';
  KOMPLYT_JWKS_URL?: string | undefined;
  KOMPLYT_ISSUER?: string | undefined;
}

/**
 * Local mode accepts unauthenticated requests, so it must never be reachable on a
 * deployment that is configured to verify Komplyt tokens.
 */
export function checkAuthEnv(e: AuthEnvFields, ctx: z.RefinementCtx): void {
  if (e.KG_AUTH_MODE !== 'local') return;
  for (const name of ['KOMPLYT_JWKS_URL', 'KOMPLYT_ISSUER'] as const) {
    if (!e[name]) continue;
    ctx.addIssue({
      code: 'custom',
      path: ['KG_AUTH_MODE'],
      message:
        `KG_AUTH_MODE=local turns token checking off and cannot be combined with ${name}; ` +
        `unset ${name}, or use KG_AUTH_MODE=komplyt`,
    });
  }
}
