import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Context } from 'hono';
import { createRateLimiter } from './rate-limit.js';

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('allows requests under limit', async () => {
    const limiter = createRateLimiter({
      limit: 5,
      windowMs: 60_000,
      keyGenerator: () => 'test-key',
    });

    const mockContext = createMockContext();
    const next = vi.fn();

    await limiter(mockContext, next);

    expect(next).toHaveBeenCalled();
    expect(mockContext.res.headers.get('X-RateLimit-Limit')).toBe('5');
    expect(mockContext.res.headers.get('X-RateLimit-Remaining')).toBe('4');
  });

  it('blocks requests over limit with 429', async () => {
    const limiter = createRateLimiter({
      limit: 2,
      windowMs: 60_000,
      keyGenerator: () => 'block-test-key',
    });

    const next1 = vi.fn();
    const next2 = vi.fn();
    const next3 = vi.fn();

    // First two requests pass
    await limiter(createMockContext(), next1);
    await limiter(createMockContext(), next2);

    expect(next1).toHaveBeenCalledTimes(1);
    expect(next2).toHaveBeenCalledTimes(1);

    // Third request blocked
    const mockContext = createMockContext();
    const result = await limiter(mockContext, next3);

    expect(next3).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(429);
  });

  it('resets after window expires', async () => {
    // Use real timers and a short window for this test
    vi.useRealTimers();

    const limiter = createRateLimiter({
      limit: 1,
      windowMs: 50, // 50ms window
      keyGenerator: () => 'reset-test-key',
    });

    const next1 = vi.fn();
    const next2 = vi.fn();
    const next3 = vi.fn();

    // First request passes
    await limiter(createMockContext(), next1);
    expect(next1).toHaveBeenCalledTimes(1);

    // Second request blocked
    await limiter(createMockContext(), next2);
    expect(next2).not.toHaveBeenCalled();

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 60));

    // Request should pass again
    await limiter(createMockContext(), next3);
    expect(next3).toHaveBeenCalledTimes(1);
  });

  it('uses separate counters per key', async () => {
    let currentKey = 'tenant-1';
    const limiter = createRateLimiter({
      limit: 1,
      windowMs: 60_000,
      keyGenerator: () => currentKey,
    });

    const next = vi.fn();

    // Tenant 1 first request
    await limiter(createMockContext(), next);
    expect(next).toHaveBeenCalledTimes(1);

    // Tenant 1 second request blocked
    await limiter(createMockContext(), next);
    expect(next).toHaveBeenCalledTimes(1);

    // Tenant 2 first request should pass
    currentKey = 'tenant-2';
    await limiter(createMockContext(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('sets Retry-After header when rate limited', async () => {
    const limiter = createRateLimiter({
      limit: 1,
      windowMs: 60_000,
      keyGenerator: () => 'retry-after-key',
    });

    const next = vi.fn();

    await limiter(createMockContext(), next);

    const result = await limiter(createMockContext(), next);

    expect(result).toBeInstanceOf(Response);
    const retryAfter = (result as Response).headers.get('Retry-After');
    expect(retryAfter).toBeDefined();
    expect(parseInt(retryAfter!, 10)).toBeGreaterThan(0);
  });
});

function createMockContext(): Context {
  return new Context(new Request('http://localhost/'));
}
