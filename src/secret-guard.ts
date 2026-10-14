import type { MiddlewareHandler } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time secret comparison. Hashing first sidesteps timingSafeEqual's
 * equal-length requirement without leaking length.
 */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Bearer-secret gate for operational endpoints. With no secret configured the
 * endpoint stays open, which keeps self-hosted setups and existing scrapers
 * working; set the secret to close it.
 */
export function bearerGuard(secret: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    if (!secret) return next();
    const header = c.req.header('Authorization');
    if (!header?.startsWith('Bearer ') || !secretsMatch(header.slice(7), secret)) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Bearer token required' } }, 401, {
        'WWW-Authenticate': 'Bearer',
      });
    }
    return next();
  };
}
