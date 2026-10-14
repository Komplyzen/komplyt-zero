/**
 * Who the stdio CLI (`kg mcp`) acts as. In local auth mode (KG_AUTH_MODE=local) that is
 * the fixed local identity, with no login and no credentials file. Otherwise it is whatever the
 * stored `kg auth login` credentials say, exactly as before.
 */
import type { KgTokenPayload } from '../contracts.js';
import { localClaims, type LocalIdentity } from '../auth-local.js';

export type StdioAuthEnv = LocalIdentity & {
  KG_AUTH_MODE: 'komplyt' | 'local';
};

export async function resolveStdioClaims(
  env: StdioAuthEnv,
  loadCredentialClaims: () => Promise<KgTokenPayload>
): Promise<KgTokenPayload> {
  if (env.KG_AUTH_MODE === 'local') return localClaims(env);
  return loadCredentialClaims();
}

export interface StdioAuthHooks {
  warn: () => void;
  publish: () => Promise<void>;
}

/**
 * Startup steps that depend on the auth mode. Local mode warns, then publishes the signin secret:
 * on a fresh database the CLI may be the first thing that ever touches it, so it does what the HTTP
 * server does at boot (creates the allowlist entry only when absent, never overwrites). Komplyt
 * mode does neither: there the CLI runs on an end-user machine and must not be able to allowlist
 * its own secret.
 */
export async function prepareStdioAuth(env: StdioAuthEnv, hooks: StdioAuthHooks): Promise<void> {
  if (env.KG_AUTH_MODE !== 'local') return;
  hooks.warn();
  await hooks.publish();
}
