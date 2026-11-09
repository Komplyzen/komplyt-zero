/**
 * Host and port to bind from LISTEN_ADDR: "host:port", ":port", "host", "[::1]:port" or "[::1]".
 * IPv6 hosts must be bracketed; the brackets are not part of the returned host (Bun.serve wants "::").
 * An unusable value throws (env-schema.ts validates LISTEN_ADDR with this function), so boot stops with a
 * clear message instead of listening on NaN.
 */
export function parseListenAddr(input: string): { host: string; port: number } {
  const addr = input.trim();
  let host: string;
  let portStr: string;
  let hasPort: boolean;

  if (addr.startsWith('[')) {
    const close = addr.indexOf(']');
    if (close === -1) throw new Error(`Invalid LISTEN_ADDR "${addr}": missing closing bracket`);
    host = addr.slice(1, close);
    if (host === '') throw new Error(`Invalid LISTEN_ADDR "${addr}": empty host in brackets`);
    const rest = addr.slice(close + 1);
    if (rest !== '' && !rest.startsWith(':')) {
      throw new Error(`Invalid LISTEN_ADDR "${addr}": expected :port after the closing bracket`);
    }
    hasPort = rest !== '';
    portStr = rest.slice(1);
  } else {
    if (addr.split(':').length > 2) {
      throw new Error(`Invalid LISTEN_ADDR "${addr}": put IPv6 hosts in brackets, e.g. [::1]:3000`);
    }
    const colon = addr.indexOf(':');
    host = colon === -1 ? addr : addr.slice(0, colon);
    hasPort = colon !== -1;
    portStr = colon === -1 ? '' : addr.slice(colon + 1);
  }

  if (hasPort && portStr === '') throw new Error(`Invalid LISTEN_ADDR "${addr}": expected a port after ":"`);
  const port = hasPort ? Number(portStr) : 3000;
  if (hasPort && (!/^\d+$/.test(portStr) || port < 1 || port > 65535)) {
    throw new Error(`Invalid LISTEN_ADDR port: "${portStr}"`);
  }
  return { host: host || '0.0.0.0', port };
}
