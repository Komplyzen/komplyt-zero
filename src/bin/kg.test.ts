/**
 * `kg auth <subcommand>` must reach the auth CLI's subcommand. bin/kg.ts used to
 * hand over with argv still reading ["auth", "status"], so bin/auth.ts took "auth" for its own
 * subcommand and every `kg auth ...` printed its usage text instead of doing anything.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The local tsx binary (no `npx` lookup, no network), and keytar is a native module: where it cannot
// load (a bare CI container without libsecret) the dispatch tests that import it are skipped.
const TSX = join(__dirname, '..', 'node_modules', '.bin', 'tsx');
let keytarLoads = true;

beforeAll(async () => {
  try {
    await import('keytar');
  } catch {
    keytarLoads = false;
  }
});

function kg(...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'kg-cli-home-'));
  return spawnSync(TSX, [join(__dirname, 'kg.ts'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: 60_000,
  });
}

describe('kg CLI dispatch', () => {
  it('`kg auth status` runs the status subcommand (not logged in, in a fresh home)', (ctx) => {
    if (!keytarLoads) return ctx.skip();
    const res = kg('auth', 'status');
    expect(res.stdout).toContain('Not logged in');
    expect(res.stdout).not.toContain('Usage: kg auth');
  });

  it('`kg auth bogus` shows the auth usage', (ctx) => {
    if (!keytarLoads) return ctx.skip();
    const res = kg('auth', 'bogus');
    expect(res.stdout).toContain('Usage: kg auth <login|logout|status>');
  });

  it('`kg` with no command shows the top-level usage, including local mode', () => {
    const res = kg();
    expect(res.stdout).toContain('kg - Knowledge Graph CLI');
    expect(res.stdout).toContain('KG_AUTH_MODE');
  });
});

describe('package.json bin', () => {
  it('exposes `kg`, built from bin/kg.ts (tsc: rootDir ".", outDir "dist")', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    expect(pkg.bin).toEqual({ kg: 'dist/bin/kg.js' });
    expect(existsSync(join(__dirname, 'kg.ts'))).toBe(true);
    expect(readFileSync(join(__dirname, 'kg.ts'), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
  });
});
