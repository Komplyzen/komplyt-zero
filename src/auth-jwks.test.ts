/**
 * Real validateToken() against a real signed token and a real (in-process) JWKS.
 *
 * auth.test.ts mocks jose entirely; nothing else in the suite proved that the KG's production
 * verification path accepts what bench-token.ts mints. This test does: it serves the JWKS the
 * signer wrote from a plain node:http server, points the env at it BEFORE auth.ts is imported
 * (env.ts parses process.env at import), and calls the unmocked validateToken.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signBenchToken } from './bin/bench-token.js';

let server: Server;
let issuer: string;
let outDir: string;
let validateToken: typeof import('./auth.js').validateToken;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'auth-jwks-'));
  const jwksPath = join(outDir, 'jwks.json');
  server = createServer(async (req, res) => {
    if (req.url === '/jwks.json') {
      res.setHeader('content-type', 'application/json');
      res.end(await readFile(jwksPath));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  issuer = `http://127.0.0.1:${addr.port}`;

  process.env.KG_DB_URL = 'ws://localhost:8000';
  process.env.KG_DB_USER = 'root';
  process.env.KG_DB_PASS = 'root';
  process.env.KG_JWT_SECRET = 'test-secret-that-is-at-least-32-characters';
  process.env.COHERE_API_KEY = 'test-key';
  process.env.KOMPLYT_ISSUER = issuer;
  process.env.KOMPLYT_JWKS_URL = `${issuer}/jwks.json`;
  process.env.KOMPLYT_AUDIENCE = 'kg-server';
  process.env.LOG_LEVEL = 'error';
  ({ validateToken } = await import('./auth.js'));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('validateToken with a job-local JWKS issuer', () => {
  it('accepts a bench token: tenantId from the claim, sub, implicit kg:read kg:write, derived principals', async () => {
    const { token } = await signBenchToken({
      outDir, issuer, audience: 'kg-server', tenantId: 'bench_run_1', sub: 'bench', ttlMinutes: 5,
    });
    const claims = await validateToken(token);
    expect(claims.tenantId).toBe('bench_run_1');
    expect(claims.sub).toBe('bench');
    expect(claims.scope.split(' ')).toEqual(expect.arrayContaining(['kg:read', 'kg:write']));
    expect(claims.principals).toEqual(expect.arrayContaining(['principal:user_bench', 'principal:tenant_bench_run_1']));
  });

  it('rejects a token signed by a different keypair even with the right issuer and audience', async () => {
    // Sign with a second keypair into another dir; the served JWKS still holds the first key.
    const other = await mkdtemp(join(tmpdir(), 'auth-jwks-other-'));
    const { token } = await signBenchToken({
      outDir: other, issuer, audience: 'kg-server', tenantId: 'bench_run_1', sub: 'bench', ttlMinutes: 5,
    });
    await expect(validateToken(token)).rejects.toThrow();
  });

  it('rejects the wrong audience', async () => {
    const { token } = await signBenchToken({
      outDir, issuer, audience: 'komplyt-api', tenantId: 'bench_run_1', sub: 'bench', ttlMinutes: 5,
    });
    await expect(validateToken(token)).rejects.toThrow();
  });
});
