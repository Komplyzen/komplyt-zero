/**
 * CAP-7: boot order. index.ts must publish the signin hash BEFORE it listens,
 * and a failed publish must stop the process. Both are properties of the
 * wiring, so this runs the real entrypoint (`bun index.ts`) as a subprocess.
 *
 * Run with: bun run vitest run boot-publish.integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createServer } from 'net';
import { join } from 'path';
import type { Surreal } from 'surrealdb';
import { connectTestDb } from './connect.js';
import { sha256Hex } from '../signin-secret.js';
import { getEnv } from '../env.js';

const SRC_DIR = join(__dirname, '..');
const OTHER_HASH = sha256Hex('a-different-secret-that-is-32-chars-long!');

let rootDb: Surreal;
let skipTests = false;
const children: ChildProcess[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

type Booted = ChildProcess & { output: string };

function boot(port: number): Booted {
  const child: Booted = spawn('bun', ['index.ts'], {
    cwd: SRC_DIR,
    env: { ...process.env, LISTEN_ADDR: `127.0.0.1:${port}`, LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as Booted;
  child.output = '';
  child.stdout?.on('data', (d) => (child.output += d));
  child.stderr?.on('data', (d) => (child.output += d));
  children.push(child);
  return child;
}

async function accepts(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
    return true;
  } catch {
    return false;
  }
}

async function allowlist(): Promise<string[] | null> {
  const [row] = await rootDb.query<[{ signin_sha256s: string[] } | null]>(
    'SELECT signin_sha256s FROM ONLY kg_config:signin'
  );
  return row?.signin_sha256s ?? null;
}

describe('index.ts boot wiring (CAP-7)', () => {
  beforeEach((ctx) => {
    if (skipTests) ctx.skip();
  });

  beforeAll(async () => {
    const conn = await connectTestDb();
    if (!conn) {
      skipTests = true;
      return;
    }
    rootDb = conn;
    const bun = spawnSync('bun', ['--version']);
    if (bun.status !== 0) {
      // A missing runtime must not turn into a vacuous pass where CI requires the DB.
      if (process.env.KG_REQUIRE_DB) throw new Error('bun is required for the boot test but was not found');
      skipTests = true;
    }
  });

  afterAll(async () => {
    for (const c of children) c.kill('SIGKILL');
    if (!rootDb) return;
    await rootDb.query('UPSERT kg_config:signin SET signin_sha256s = [$hash]', {
      hash: sha256Hex(getEnv().KG_JWT_SECRET),
    });
    await rootDb.close();
  });

  it('a rejected hash stops the process with the fatal reason, and the port never accepts a connection', async () => {
    await rootDb.query('UPSERT kg_config:signin SET signin_sha256s = [$h]', { h: OTHER_HASH });
    const port = await freePort();
    const child = boot(port);

    // Probe the port for the whole life of the process, not just after it died:
    // a regression that listens first and publishes second must be caught.
    let everAccepted = false;
    while (child.exitCode === null) {
      if (await accepts(port)) everAccepted = true;
      await new Promise((r) => setTimeout(r, 100));
    }
    // Non-retried rejection: well under the ~91s retry budget.
    expect(child.exitCode).toBe(1);
    expect(everAccepted).toBe(false);
    // Exit 1 alone is not enough (any early crash exits 1): the logged reason must be ours.
    expect(child.output).toMatch(/refusing to start/);
    expect(child.output).toMatch(/SigninSecretNotAcceptedError/);
    expect(await allowlist()).toEqual([OTHER_HASH]);
  }, 60_000);

  it('a good boot has published the hash before /ready returns 200', async () => {
    await rootDb.query('DELETE kg_config:signin');
    const port = await freePort();
    const child = boot(port);

    try {
      let status = 0;
      let listenedBeforePublished = false;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && status !== 200) {
        if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}\n${child.output}`);
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
          // The port answers: the row must already exist.
          if (res.status && (await allowlist()) === null) listenedBeforePublished = true;
          status = (await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(2_000) })).status;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      expect(listenedBeforePublished).toBe(false);
      expect(status).toBe(200);
      expect(await allowlist()).toEqual([sha256Hex(getEnv().KG_JWT_SECRET)]);
    } finally {
      child.kill('SIGKILL');
    }
  }, 90_000);
});
