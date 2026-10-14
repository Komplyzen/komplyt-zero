import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { checkLocalRequest, isLoopbackBind, isLoopbackHost, type LocalGuardConfig } from './local-guard.js';

const config: LocalGuardConfig = { allowedOrigins: ['http://localhost:5173'], allowedHosts: ['kg.internal:3000'] };
const post = (over: Partial<Parameters<typeof checkLocalRequest>[0]> = {}) =>
  checkLocalRequest(
    { method: 'POST', contentType: 'application/json', origin: undefined, host: 'localhost:3000', ...over },
    config
  );

describe('checkLocalRequest', () => {
  it('lets a normal MCP client through (no Origin, JSON, loopback host)', () => {
    expect(post()).toBeNull();
    expect(post({ contentType: 'application/json; charset=utf-8', host: '127.0.0.1:3000' })).toBeNull();
    expect(post({ host: '[::1]:3000' })).toBeNull();
  });

  it('rejects a cross-site text/plain POST (the no-preflight CSRF)', () => {
    expect(post({ contentType: 'text/plain', origin: 'https://evil.example' })?.status).toBe(403);
    expect(post({ contentType: 'text/plain' })?.status).toBe(415);
  });

  it('rejects a foreign Origin even with JSON, allows a listed one', () => {
    expect(post({ origin: 'https://evil.example' })?.status).toBe(403);
    expect(post({ origin: 'http://localhost:5173' })).toBeNull();
  });

  it('rejects a rebound Host, allows an explicitly listed one', () => {
    expect(post({ host: 'evil.example:3000' })?.status).toBe(403);
    expect(post({ host: 'KG.internal:3000' })).toBeNull();
  });

  it('does not demand JSON on GET or DELETE', () => {
    expect(post({ method: 'GET', contentType: undefined })).toBeNull();
    expect(post({ method: 'DELETE', contentType: undefined })).toBeNull();
  });

  it('works as Hono middleware', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      const r = checkLocalRequest(
        { method: c.req.method, contentType: c.req.header('Content-Type'), origin: c.req.header('Origin'), host: c.req.header('Host') },
        config
      );
      return r ? c.json({ error: r.message }, r.status) : next();
    });
    app.post('/mcp', (c) => c.text('ran'));
    const evil = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example', Host: 'localhost:3000' },
      body: '{}',
    });
    expect(evil.status).toBe(403);
    const ok = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: 'localhost:3000' },
      body: '{}',
    });
    expect(await ok.text()).toBe('ran');
  });
});

describe('loopback helpers', () => {
  it('classifies hosts and binds', () => {
    expect(isLoopbackHost('localhost:3000')).toBe(true);
    expect(isLoopbackHost('192.168.1.5:3000')).toBe(false);
    expect(isLoopbackBind('127.0.0.1')).toBe(true);
    expect(isLoopbackBind('0.0.0.0')).toBe(false);
  });
});
