import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { bearerGuard, secretsMatch } from './secret-guard.js';

function app(secret: string | undefined): Hono {
  const a = new Hono();
  a.use('/metrics', bearerGuard(secret));
  a.get('/metrics', (c) => c.text('data'));
  return a;
}

describe('bearerGuard', () => {
  it('leaves the endpoint open when no secret is configured', async () => {
    expect((await app(undefined).request('/metrics')).status).toBe(200);
  });

  it('rejects a missing, malformed or wrong token with 401 and a challenge', async () => {
    const a = app('s3cr3t-token-value-123');
    for (const headers of [{}, { Authorization: 'Basic abc' }, { Authorization: 'Bearer nope' }] as Record<string, string>[]) {
      const res = await a.request('/metrics', { headers });
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
    }
  });

  it('accepts the right token, case-sensitively', async () => {
    const a = app('AbCdEf-Token-123456');
    expect((await a.request('/metrics', { headers: { Authorization: 'Bearer AbCdEf-Token-123456' } })).status).toBe(200);
    expect((await a.request('/metrics', { headers: { Authorization: 'Bearer abcdef-token-123456' } })).status).toBe(401);
  });
});

describe('secretsMatch', () => {
  it('compares without needing equal lengths', () => {
    expect(secretsMatch('a', 'a')).toBe(true);
    expect(secretsMatch('a', 'ab')).toBe(false);
  });
});
