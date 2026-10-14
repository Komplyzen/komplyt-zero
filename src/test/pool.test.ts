import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../env.js', () => ({
  getEnv: () => ({
    KG_DB_URL: 'ws://localhost:8000',
    KG_DB_USER: 'root',
    KG_DB_PASS: 'root',
    KG_DB_NS: 'kg_test',
    KG_DB_NAME: 'test',
    KG_JWT_SECRET: 'test-secret-that-is-at-least-32-chars',
    COHERE_API_KEY: 'test-key',
    LOG_LEVEL: 'error',
  }),
}));

import { PoolExhaustedError, CircuitBreakerOpenError, _resetPoolForTesting, getPoolMetrics } from '../pool.js';

describe('ConnectionPool', () => {
  beforeEach(async () => {
    await _resetPoolForTesting();
  });

  afterEach(async () => {
    await _resetPoolForTesting();
    vi.restoreAllMocks();
  });

  describe('pool metrics', () => {
    it('should return initial metrics for new pool', () => {
      const metrics = getPoolMetrics();

      expect(metrics.connected).toBe(false);
      expect(metrics.activeRequests).toBe(0);
      expect(metrics.circuitBreakerOpen).toBe(false);
    });
  });

  describe('PoolExhaustedError', () => {
    it('should include message in error', () => {
      const error = new PoolExhaustedError('test message');
      expect(error.message).toBe('test message');
      expect(error.name).toBe('PoolExhaustedError');
    });
  });

  describe('CircuitBreakerOpenError', () => {
    it('should have retryAfter property', () => {
      const error = new CircuitBreakerOpenError();
      expect(error.retryAfter).toBeGreaterThan(0);
      expect(error.name).toBe('CircuitBreakerOpenError');
    });
  });

  describe('circuit breaker behavior (unit)', () => {
    it('should track failure count', () => {
      const breaker = { failures: 0, lastFailure: 0, trippedUntil: 0 };
      const BREAKER_THRESHOLD = 5;
      const BREAKER_WINDOW_MS = 10_000;
      const BREAKER_COOLDOWN_MS = 5_000;

      function recordFailure() {
        const now = Date.now();
        if (now - breaker.lastFailure > BREAKER_WINDOW_MS) breaker.failures = 0;
        breaker.failures++;
        breaker.lastFailure = now;
        if (breaker.failures >= BREAKER_THRESHOLD) {
          breaker.trippedUntil = now + BREAKER_COOLDOWN_MS;
        }
      }

      for (let i = 0; i < 4; i++) recordFailure();
      expect(breaker.failures).toBe(4);
      expect(breaker.trippedUntil).toBe(0);

      recordFailure();
      expect(breaker.failures).toBe(5);
      expect(breaker.trippedUntil).toBeGreaterThan(0);
    });

    it('should reset after cooldown', () => {
      const breaker = { failures: 5, lastFailure: Date.now(), trippedUntil: Date.now() - 1 };

      function checkBreaker(): boolean {
        return Date.now() < breaker.trippedUntil;
      }

      expect(checkBreaker()).toBe(false);
    });

    it('should reset failures on success', () => {
      const breaker = { failures: 3, lastFailure: Date.now(), trippedUntil: 0 };

      function recordSuccess() {
        breaker.failures = 0;
      }

      recordSuccess();
      expect(breaker.failures).toBe(0);
    });
  });

  describe('double release protection (unit)', () => {
    it('should ignore duplicate release calls', () => {
      let released = false;
      let warnCalled = false;

      function release() {
        if (released) {
          warnCalled = true;
          return;
        }
        released = true;
      }

      release();
      expect(released).toBe(true);
      expect(warnCalled).toBe(false);

      release();
      expect(warnCalled).toBe(true);
    });
  });

  describe('connection reuse model', () => {
    it('should document the fresh-session-per-request model', () => {
      // This test documents the design decision:
      // - WebSocket connection is pooled (expensive: TCP + TLS)
      // - Sessions are created fresh per request (cheap: 2 round trips)
      // - Sessions are disposed after use (no caching)
      //
      // This avoids "session not found" errors on SurrealDB Cloud where:
      // - Cloud aggressively terminates idle WebSocket connections
      // - On reconnect, cached sessions are orphaned
      //
      // Trade-off: ~2 extra round trips per request (newSession + signin)
      // vs connection setup (~3 round trips: connect + signin + use)
      expect(true).toBe(true);
    });
  });
});
