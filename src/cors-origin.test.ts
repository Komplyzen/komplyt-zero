import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { resolveCorsOrigin } from './cors-origin.js';

function app(origin: string[]) {
  const a = new Hono();
  a.use(
    '*',
    cors({
      origin,
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
    })
  );
  a.post('/mcp', (c) => c.text('ok'));
  return a;
}

const preflight = (a: Hono, origin: string) =>
  a.request('/mcp', {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
  });

describe('resolveCorsOrigin', () => {
  it("komplyt mode keeps today's default: any origin", () => {
    expect(resolveCorsOrigin({ KG_AUTH_MODE: 'komplyt', CORS_ORIGINS: undefined })).toEqual(['*']);
  });

  it('local mode defaults to no cross-origin access at all', () => {
    expect(resolveCorsOrigin({ KG_AUTH_MODE: 'local', CORS_ORIGINS: undefined })).toEqual([]);
  });

  it('configured origins win in both modes', () => {
    const origins = ['https://app.example'];
    expect(resolveCorsOrigin({ KG_AUTH_MODE: 'komplyt', CORS_ORIGINS: origins })).toEqual(origins);
    expect(resolveCorsOrigin({ KG_AUTH_MODE: 'local', CORS_ORIGINS: origins })).toEqual(origins);
  });

  it('local mode: a web page from another origin gets no CORS permission', async () => {
    const a = app(resolveCorsOrigin({ KG_AUTH_MODE: 'local', CORS_ORIGINS: undefined }));
    const res = await preflight(a, 'https://evil.example');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('komplyt mode: unchanged, a foreign origin gets no CORS permission by default either (Hono matches arrays by equality)', async () => {
    const a = app(resolveCorsOrigin({ KG_AUTH_MODE: 'komplyt', CORS_ORIGINS: undefined }));
    const res = await preflight(a, 'https://app.example');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('a configured origin is allowed in either mode, and only that one', async () => {
    for (const KG_AUTH_MODE of ['komplyt', 'local'] as const) {
      const a = app(resolveCorsOrigin({ KG_AUTH_MODE, CORS_ORIGINS: ['https://app.example'] }));
      expect((await preflight(a, 'https://app.example')).headers.get('access-control-allow-origin')).toBe(
        'https://app.example'
      );
      expect(
        (await preflight(a, 'https://evil.example')).headers.get('access-control-allow-origin')
      ).toBeNull();
    }
  });
});
