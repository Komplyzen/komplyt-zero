/**
 * Which web origins may call the HTTP server from a browser.
 *
 * Hosted (komplyt mode) keeps exactly what it had: the list ['*']. Note what that list does in Hono's
 * cors(): an ARRAY is matched by equality against the request's Origin, so ['*'] never matches a real
 * origin and no Access-Control-Allow-Origin header is sent. Cross-origin browser access is therefore
 * off unless CORS_ORIGINS names the origins. Local auth mode has no token, so that must stay true
 * there; its default is spelled out as an empty list, so a future change of the hosted default (say to
 * the string '*') cannot silently open a token-less server to every web page.
 */
export interface CorsEnv {
  KG_AUTH_MODE: 'komplyt' | 'local';
  CORS_ORIGINS?: string[] | undefined;
}

export function resolveCorsOrigin(env: CorsEnv): string[] {
  if (env.CORS_ORIGINS) return env.CORS_ORIGINS;
  return env.KG_AUTH_MODE === 'local' ? [] : ['*'];
}
