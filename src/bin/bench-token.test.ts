/**
 * Unit tests for the job-local benchmark issuer.
 *
 * Proves the produced JWKS verifies the produced token with the same
 * issuer/audience checks validateToken performs, that the payload carries
 * exactly the claims auth.ts requires and none it must not, and that the
 * private key is written with owner-only permissions.
 */

import { describe, it, expect } from 'vitest';
import { createLocalJWKSet, jwtVerify, decodeJwt } from 'jose';
import { mkdtemp, stat, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { signBenchToken } from './bench-token.js';

const ISS = 'http://127.0.0.1:8090';
const AUD = 'kg-server';

async function mint(ttlMinutes = 10) {
  const outDir = await mkdtemp(join(tmpdir(), 'bench-token-'));
  const result = await signBenchToken({
    outDir,
    issuer: ISS,
    audience: AUD,
    tenantId: 'bench_test_1',
    sub: 'bench',
    ttlMinutes,
  });
  return { outDir, ...result };
}

describe('signBenchToken', () => {
  it('produces a token the written JWKS verifies with issuer and audience checks', async () => {
    const { outDir, token, kid } = await mint();
    const jwks = JSON.parse(await readFile(join(outDir, 'jwks.json'), 'utf8'));
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0].kid).toBe(kid);
    expect(jwks.keys[0]).not.toHaveProperty('d'); // public key only

    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: ISS,
      audience: AUD,
    });
    expect(protectedHeader.alg).toBe('RS256');
    expect(protectedHeader.kid).toBe(kid);
    expect(payload.tenantId).toBe('bench_test_1');
    expect(payload.sub).toBe('bench');
  });

  it('carries only the claims validateToken needs: no scope, no principals, no SurrealDB fields', async () => {
    const { token } = await mint();
    const payload = decodeJwt(token);
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sub', 'tenantId']);
    // auth.ts rejects tokens with ns/db/ac as SurrealDB tokens
    expect(payload).not.toHaveProperty('ns');
    expect(payload).not.toHaveProperty('db');
    expect(payload).not.toHaveProperty('ac');
  });

  it('expires after the requested ttl', async () => {
    const { token, expiresAt } = await mint(30);
    const payload = decodeJwt(token);
    const now = Math.floor(Date.now() / 1000);
    expect(payload.exp).toBeGreaterThan(now + 29 * 60);
    expect(payload.exp).toBeLessThanOrEqual(now + 30 * 60 + 1);
    expect(expiresAt.getTime() / 1000).toBe(payload.exp);
  });

  it('rejects a token signed by a different leg', async () => {
    const a = await mint();
    const b = await mint();
    const jwksA = JSON.parse(await readFile(join(a.outDir, 'jwks.json'), 'utf8'));
    await expect(jwtVerify(b.token, createLocalJWKSet(jwksA), { issuer: ISS, audience: AUD })).rejects.toThrow();
  });

  it('rejects the wrong audience', async () => {
    const { outDir, token } = await mint();
    const jwks = JSON.parse(await readFile(join(outDir, 'jwks.json'), 'utf8'));
    await expect(jwtVerify(token, createLocalJWKSet(jwks), { issuer: ISS, audience: 'komplyt-api' })).rejects.toThrow();
  });

  it('writes the private key owner-only', async () => {
    const { outDir } = await mint();
    const mode = (await stat(join(outDir, 'private.pem'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
