/**
 * Failure-mode tests for publishSigninSecret that a healthy real database
 * cannot produce (timeouts, an SDK that returns instead of throwing, a
 * malformed row, a DB without the kg_config table). The connection is a fake
 * implementation of the two calls publish uses; behaviour against the real
 * engine is covered by test/signin-secret.integration.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import type { Surreal } from 'surrealdb';
import {
  publishSigninSecret,
  sha256Hex,
  SigninAllowlistError,
  SigninSecretNotAcceptedError,
} from './signin-secret.js';

const SECRET = 'unit-test-secret-at-least-32-characters!!';
const OWN = sha256Hex(SECRET);

type Handler = (sql: string, vars?: Record<string, unknown>) => unknown;

function fakeConn(handler: Handler) {
  const conn = {
    closed: 0,
    query: vi.fn(async (sql: string, vars?: Record<string, unknown>) =>
      sql.startsWith('INFO') ? [{ tables: { kg_config: 'DEFINE TABLE kg_config' } }] : [handler(sql, vars)]
    ),
    close: vi.fn(async () => {
      conn.closed++;
    }),
  };
  return conn;
}

const asSurreal = (c: unknown) => c as Surreal;

describe('publishSigninSecret failure modes', () => {
  it('hashes the secret as lowercase hex sha256', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('fails immediately on a row whose list is not an array (no retry)', async () => {
    const conn = fakeConn(() => ({ signin_sha256s: 'oops' }));
    const connect = vi.fn(async () => asSurreal(conn));
    await expect(
      publishSigninSecret({ connect, secret: SECRET, retryDelaysMs: [1, 1], attemptTimeoutMs: 1000 })
    ).rejects.toBeInstanceOf(SigninAllowlistError);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(conn.closed).toBe(1);
  });

  it('fails immediately, without creating anything, when kg_config is not defined (migrations missing)', async () => {
    const conn = fakeConn(() => null);
    conn.query.mockImplementation(async (sql: string) => (sql.startsWith('INFO') ? [{ tables: {} }] : [null]));
    const connect = vi.fn(async () => asSurreal(conn));
    await expect(
      publishSigninSecret({ connect, secret: SECRET, retryDelaysMs: [1], attemptTimeoutMs: 1000 })
    ).rejects.toThrow(/apply database\/migrations/);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(conn.query.mock.calls.map(([sql]) => sql).some((sql) => sql.startsWith('CREATE'))).toBe(false);
  });

  it('re-reads after CREATE and rejects if the own hash is not there', async () => {
    let reads = 0;
    const conn = fakeConn((sql) => {
      if (sql.startsWith('SELECT')) return reads++ === 0 ? null : { signin_sha256s: ['f'.repeat(64)] };
      return []; // CREATE "succeeded" without throwing
    });
    await expect(
      publishSigninSecret({
        connect: async () => asSurreal(conn),
        secret: SECRET,
        retryDelaysMs: [1],
        attemptTimeoutMs: 1000,
      })
    ).rejects.toBeInstanceOf(SigninSecretNotAcceptedError);
  });

  it('retries transient connect failures then succeeds', async () => {
    const conn = fakeConn(() => ({ signin_sha256s: [OWN] }));
    const connect = vi
      .fn<() => Promise<Surreal>>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(asSurreal(conn));
    await publishSigninSecret({ connect, secret: SECRET, retryDelaysMs: [1, 1], attemptTimeoutMs: 1000 });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry budget with the last error', async () => {
    const connect = vi.fn(async (): Promise<Surreal> => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      publishSigninSecret({ connect, secret: SECRET, retryDelaysMs: [1, 1], attemptTimeoutMs: 1000 })
    ).rejects.toThrow(/ECONNREFUSED/);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('times out a hung attempt and closes a connection that arrives late without using it', async () => {
    const late = fakeConn(() => ({ signin_sha256s: [OWN] }));
    let release!: () => void;
    const connect = vi
      .fn<() => Promise<Surreal>>()
      .mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(asSurreal(late)))))
      .mockResolvedValue(asSurreal(fakeConn(() => ({ signin_sha256s: [OWN] }))));
    await publishSigninSecret({ connect, secret: SECRET, retryDelaysMs: [1], attemptTimeoutMs: 20 });
    release(); // the abandoned attempt's connection finally opens
    await new Promise((r) => setTimeout(r, 10));
    expect(late.closed).toBe(1);
    expect(late.query).not.toHaveBeenCalled();
  });
});

describe('publishSigninSecret call sites', () => {
  // Only the HTTP server and, in local auth mode only, the stdio CLI may publish. In komplyt
  // mode the stdio MCP runs on end-user machines, and publishing from there would let any local
  // user allowlist themselves; in local mode the CLI may be the first thing to touch a
  // fresh self-hosted database, and the operator who set KG_AUTH_MODE=local owns it anyway.
  it('is referenced only by index.ts, the stdio CLI and its own module (plus tests)', () => {
    const root = __dirname;
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules') continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (
          name.endsWith('.ts') &&
          !name.endsWith('.test.ts') &&
          readFileSync(full, 'utf8').includes('publishSigninSecret')
        ) {
          hits.push(relative(root, full));
        }
      }
    };
    walk(root);
    expect(hits.sort()).toEqual(['bin/mcp.ts', 'index.ts', 'signin-secret.ts']);
  });

});
