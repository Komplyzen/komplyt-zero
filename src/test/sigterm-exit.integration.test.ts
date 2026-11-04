/**
 * A SIGTERM after the server has started must end the process with exit code 0 soon after the
 * drain, not leave it running until the orchestrator's SIGKILL (exit 137, `docker stop` after 10 s).
 * That is a property of the entrypoint, so this runs the real `bun index.ts` as a subprocess.
 *
 * Run with: bun run vitest run sigterm-exit.integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createServer } from 'net';
import { join } from 'path';
import type { Surreal } from 'surrealdb';
import { connectTestDb } from './connect.js';

const SRC_DIR = join(__dirname, '..');

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

interface Booted extends ChildProcess {
  output: string;
}

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

async function until(what: string, ok: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('index.ts SIGTERM handling', () => {
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
      if (process.env.KG_REQUIRE_DB) throw new Error('bun is required for the SIGTERM test but was not found');
      skipTests = true;
    }
  });

  afterAll(async () => {
    for (const c of children) c.kill('SIGKILL');
    await rootDb?.close();
  });

  it('exits with code 0 within 5 s of SIGTERM once the server is serving and idle', async () => {
    const port = await freePort();
    const child = boot(port);
    await until('the server to start', () => child.output.includes('Server started') || child.exitCode !== null, 60_000);
    expect(child.exitCode, child.output).toBeNull();

    const sentAt = Date.now();
    child.kill('SIGTERM');
    await until('the process to exit', () => child.exitCode !== null || child.signalCode !== null, 5_000);

    expect(child.signalCode).toBeNull();
    expect(child.exitCode, child.output).toBe(0);
    expect(Date.now() - sentAt).toBeLessThan(5_000);
    expect(child.output).toContain('Graceful shutdown complete');
  }, 90_000);
});
