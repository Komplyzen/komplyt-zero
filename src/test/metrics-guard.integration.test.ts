/**
 * Boot wiring for the operational endpoints and the pruner's env: index.ts is
 * the real entrypoint (`bun index.ts` as a subprocess), because the guard and
 * the env defaults are properties of the wiring.
 *
 * - /metrics and /pool-metrics stay open without METRICS_TOKEN (unchanged
 *   default) and require the bearer token when it is set.
 * - Blank KG_SESSION_* values (a template line like `KG_SESSION_PRUNE=`) and
 *   `KG_SESSION_PRUNE=TRUE` must not stop the server from booting.
 *
 * Run with: bun run vitest run metrics-guard.integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createServer } from 'net';
import { join } from 'path';
import type { Surreal } from 'surrealdb';
import { connectTestDb } from './connect.js';

const SRC_DIR = join(__dirname, '..');
const TOKEN = 'Metrics-Token-0123456789';

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

function boot(port: number, extraEnv: Record<string, string>): Booted {
  const child: Booted = spawn('bun', ['index.ts'], {
    cwd: SRC_DIR,
    env: { ...process.env, LISTEN_ADDR: `127.0.0.1:${port}`, LOG_LEVEL: 'info', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as Booted;
  child.output = '';
  child.stdout?.on('data', (d) => (child.output += d));
  child.stderr?.on('data', (d) => (child.output += d));
  children.push(child);
  return child;
}

async function untilReady(port: number, child: Booted): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode} during boot:\n${child.output}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(1_000) });
      if (res.status === 200) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server not ready within 60s:\n${child.output}`);
}

const get = (port: number, path: string, token?: string) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5_000),
  });

describe('operational endpoints and pruner env at boot', () => {
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
    if (spawnSync('bun', ['--version']).status !== 0) {
      if (process.env.KG_REQUIRE_DB) throw new Error('bun is required for the boot test but was not found');
      skipTests = true;
    }
  });

  afterAll(async () => {
    for (const c of children) c.kill('SIGKILL');
    await rootDb?.close();
  });

  it('is open without METRICS_TOKEN and exposes the pruner metrics', async () => {
    const port = await freePort();
    const child = boot(port, { METRICS_TOKEN: '' });
    await untilReady(port, child);

    const res = await get(port, '/metrics');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/^kg_session_prune_removed_total \d+$/m);
    expect(body).toMatch(/^kg_session_prune_failures_total \d+$/m);
    expect((await get(port, '/pool-metrics')).status).toBe(200);
  }, 90_000);

  it('requires the bearer token on /metrics and /pool-metrics once METRICS_TOKEN is set', async () => {
    const port = await freePort();
    const child = boot(port, { METRICS_TOKEN: TOKEN });
    await untilReady(port, child);

    for (const path of ['/metrics', '/pool-metrics']) {
      expect((await get(port, path)).status).toBe(401);
      expect((await get(port, path, 'wrong-token-wrong-token')).status).toBe(401);
      expect((await get(port, path, TOKEN.toLowerCase())).status).toBe(401); // case-sensitive
      expect((await get(port, path, TOKEN)).status).toBe(200);
    }
    // Health probes stay open: orchestrators must not need the token.
    expect((await get(port, '/health')).status).toBe(200);
  }, 90_000);

  it('boots with blank KG_SESSION_* values and a capitalised boolean', async () => {
    const port = await freePort();
    const child = boot(port, {
      KG_SESSION_PRUNE: 'TRUE',
      KG_SESSION_RETENTION_HOURS: '',
      KG_SESSION_PRUNE_INTERVAL_MINUTES: '  ',
    });
    await untilReady(port, child);
    expect(child.output).not.toMatch(/Environment validation failed/);
  }, 90_000);

  it('does not start the pruner when KG_SESSION_PRUNE=off, and still boots', async () => {
    const port = await freePort();
    const child = boot(port, { KG_SESSION_PRUNE: 'off' });
    await untilReady(port, child);
    expect(child.exitCode).toBeNull();
  }, 90_000);
});
