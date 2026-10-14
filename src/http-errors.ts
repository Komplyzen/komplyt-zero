/**
 * The HTTP server's global error handler: maps errors that escape a route to
 * the standard `{ error: { code, message } }` body. Tool failures never get
 * here (they are toolError results); this catches AuthError, pool/breaker
 * back-pressure, Hono HTTPExceptions (e.g. a malformed JSON body) and anything
 * unexpected.
 */
import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from 'pino';
import { AuthError } from './auth.js';
import { ErrorCode } from './contracts.js';
import { PoolExhaustedError, CircuitBreakerOpenError } from './pool.js';

/** ErrorCode for a client-error HTTP status raised as an HTTPException. */
function httpExceptionCode(status: number): ErrorCode {
  if (status === 401 || status === 403) return ErrorCode.AUTH;
  if (status === 404) return ErrorCode.NOT_FOUND;
  if (status === 429) return ErrorCode.RATE_LIMIT;
  return ErrorCode.VALIDATION;
}

/** Context variables the handler reads (set by index.ts's request-ID middleware). */
export type ErrorHandlerEnv = { Variables: { requestId: string } };

export function createErrorHandler(logger: Pick<Logger, 'debug' | 'error'>): ErrorHandler<ErrorHandlerEnv> {
  return (err, c) => {
    const requestId = c.get('requestId');

    if (err instanceof AuthError) {
      return c.json(
        { error: { code: ErrorCode.AUTH, message: err.message } },
        err.statusCode as 401 | 403 | 503,
      );
    }

    if (err instanceof PoolExhaustedError) {
      c.res.headers.set('Retry-After', '1');
      return c.json(
        { error: { code: ErrorCode.RATE_LIMIT, message: 'Service temporarily unavailable' } },
        503,
      );
    }

    if (err instanceof CircuitBreakerOpenError) {
      c.res.headers.set('Retry-After', String(err.retryAfter));
      return c.json(
        { error: { code: ErrorCode.RATE_LIMIT, message: 'Service temporarily unavailable' } },
        503,
      );
    }

    // Client errors raised by Hono itself (malformed JSON body, etc.). The
    // request log line already records the 4xx at warn, so this stays at debug.
    if (err instanceof HTTPException && err.status < 500) {
      logger.debug({ err, requestId }, 'HTTP exception');
      return c.json({ error: { code: httpExceptionCode(err.status), message: err.message || 'Bad request' } }, err.status);
    }

    logger.error({ err, requestId }, 'Unhandled error');
    return c.json({ error: { code: ErrorCode.INTERNAL, message: 'Internal server error' } }, 500);
  };
}
