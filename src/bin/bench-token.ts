#!/usr/bin/env bun
/**
 * Job-local issuer for benchmark legs.
 *
 * Generates an RS256 keypair, writes `jwks.json` (public key only) into
 * --out-dir for a localhost static server to serve, and prints a JWT that
 * `validateToken` in auth.ts accepts when the KG server is started with
 * KOMPLYT_JWKS_URL pointing at that file and KOMPLYT_ISSUER / KOMPLYT_AUDIENCE
 * matching --issuer / --audience.
 *
 * The token carries exactly what validateToken requires: iss, aud, sub,
 * tenantId, exp. No `scope` (auth.ts grants kg:read kg:write implicitly),
 * no `principals` (derived server-side from the claims). The private key is
 * written next to the JWKS with mode 0600 so a leg can mint a second token
 * after expiry; it never leaves the leg's temp dir.
 *
 * No import of env.ts on purpose: this runs before any server env exists.
 */

import { generateKeyPair, exportJWK, exportPKCS8, SignJWT, type JWK } from 'jose';
import { mkdir, writeFile, chmod } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';

export interface BenchTokenOptions {
  outDir: string;
  issuer: string;
  audience: string;
  tenantId: string;
  sub: string;
  ttlMinutes: number;
}

export interface BenchTokenResult {
  token: string;
  jwks: { keys: JWK[] };
  kid: string;
  expiresAt: Date;
}

export async function signBenchToken(opts: BenchTokenOptions): Promise<BenchTokenResult> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const kid = `bench-${randomUUID()}`;
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const jwks = { keys: [publicJwk] };

  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.round(opts.ttlMinutes * 60);
  const token = await new SignJWT({ tenantId: opts.tenantId })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setSubject(opts.sub)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(privateKey);

  await mkdir(opts.outDir, { recursive: true });
  await writeFile(join(opts.outDir, 'jwks.json'), JSON.stringify(jwks, null, 2));
  const pemPath = join(opts.outDir, 'private.pem');
  await writeFile(pemPath, await exportPKCS8(privateKey));
  await chmod(pemPath, 0o600);

  return { token, jwks, kid, expiresAt: new Date(exp * 1000) };
}

function argValue(argv: string[], name: string, fallback?: string): string {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1] !== undefined) return argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required argument ${name}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const ttl = Number(argValue(argv, '--ttl-minutes', '310'));
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error('--ttl-minutes must be a positive number');
  const result = await signBenchToken({
    outDir: argValue(argv, '--out-dir'),
    issuer: argValue(argv, '--issuer'),
    audience: argValue(argv, '--audience', 'kg-server'),
    tenantId: argValue(argv, '--tenant'),
    sub: argValue(argv, '--sub', 'bench'),
    ttlMinutes: ttl,
  });
  // Token on stdout only; everything else on stderr so callers can capture it.
  process.stderr.write(`jwks kid=${result.kid} expires=${result.expiresAt.toISOString()}\n`);
  process.stdout.write(result.token + '\n');
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`bench-token: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
