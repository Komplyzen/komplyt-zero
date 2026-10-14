/**
 * Request guard for local auth mode (KG_AUTH_MODE=local). With no token, anything that can reach the
 * port acts as the fixed local user, and a web page the user happens to have open can reach
 * localhost. CORS alone does not stop that: a POST with Content-Type text/plain is a "simple
 * request" that needs no preflight, and the server would still run it. This closes those paths.
 */

export interface LocalGuardRequest {
  method: string;
  contentType: string | undefined;
  origin: string | undefined;
  host: string | undefined;
}

export interface LocalGuardConfig {
  /** CORS_ORIGINS: the only browser origins allowed to call the server. */
  allowedOrigins: readonly string[];
  /** KG_LOCAL_ALLOWED_HOSTS: extra Host values (for example behind a reverse proxy). */
  allowedHosts: readonly string[];
}

export interface LocalGuardRejection {
  status: 403 | 415;
  message: string;
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

function hostname(hostHeader: string): string {
  // "[::1]:3000" -> "[::1]"; "localhost:3000" -> "localhost"
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1).toLowerCase();
  return hostHeader.split(':')[0]!.toLowerCase();
}

export function isLoopbackHost(hostHeader: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname(hostHeader));
}

/** Bind addresses that only the local machine can reach. */
export function isLoopbackBind(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');
}

/** null when the request may proceed. */
export function checkLocalRequest(
  req: LocalGuardRequest,
  config: LocalGuardConfig
): LocalGuardRejection | null {
  // DNS rebinding: the attacker's domain resolves to 127.0.0.1, so the Host header is theirs.
  if (req.host !== undefined) {
    const allowed = isLoopbackHost(req.host) || config.allowedHosts.includes(req.host.toLowerCase());
    if (!allowed) {
      return { status: 403, message: `Host ${req.host} is not allowed in local auth mode (see KG_LOCAL_ALLOWED_HOSTS)` };
    }
  }
  // A browser always sends Origin on cross-origin POSTs; curl and MCP clients do not.
  if (req.origin !== undefined && !config.allowedOrigins.includes(req.origin)) {
    return { status: 403, message: `Origin ${req.origin} is not allowed in local auth mode (see CORS_ORIGINS)` };
  }
  // Forces a CORS preflight for any browser caller.
  if (BODY_METHODS.has(req.method.toUpperCase()) && !/^application\/json\b/i.test(req.contentType ?? '')) {
    return { status: 415, message: 'Content-Type must be application/json' };
  }
  return null;
}
