import type { Context, MiddlewareHandler } from 'hono';
import { ErrorCode } from './contracts.js';

interface RateLimitConfig {
  limit: number;
  windowMs: number;
  keyGenerator: (c: Context) => string;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory store - rate limits are per-process. For multi-worker
// deployments, replace with Redis-backed store.
const store = new Map<string, RateLimitEntry>();

// Cleanup stale entries every 5 minutes
setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetAt < now) {
        store.delete(key);
      }
    }
  },
  5 * 60 * 1000,
);

export function createRateLimiter(config: RateLimitConfig): MiddlewareHandler {
  return async (c, next) => {
    const key = config.keyGenerator(c);
    const now = Date.now();

    let entry = store.get(key);
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + config.windowMs };
      store.set(key, entry);
    }

    entry.count++;

    // Set rate limit headers
    c.res.headers.set('X-RateLimit-Limit', String(config.limit));
    c.res.headers.set('X-RateLimit-Remaining', String(Math.max(0, config.limit - entry.count)));
    c.res.headers.set('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > config.limit) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      c.res.headers.set('Retry-After', String(retryAfter));
      return c.json(
        { error: { code: ErrorCode.RATE_LIMIT, message: 'Rate limit exceeded' } },
        429,
      );
    }

    await next();
  };
}
