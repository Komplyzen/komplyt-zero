/**
 * The secret-scanning rules (.gitleaks.toml) must catch the credential shapes this project
 * uses and must not flag the documented placeholders. Probe values are built at run time so that
 * this file does not trip the scanner it tests.
 *
 * Needs the gitleaks binary. Without it the suite is skipped, unless REQUIRE_GITLEAKS=1 (CI), in
 * which case a missing binary fails the run.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const CONFIG = join(ROOT, '.gitleaks.toml');

const hasGitleaks = spawnSync('gitleaks', ['version']).status === 0;
const required = process.env.REQUIRE_GITLEAKS === '1';

const random = (bytes = 24) => randomBytes(bytes).toString('base64url');

let dir: string;

function scan(content: string) {
  writeFileSync(join(dir, 'probe.txt'), content);
  return spawnSync('gitleaks', ['dir', '--config', CONFIG, '--no-banner', '--redact', '-l', 'error', dir], {
    encoding: 'utf8',
  });
}

describe('.gitleaks.toml', () => {
  beforeAll(() => {
    if (required && !hasGitleaks) throw new Error('REQUIRE_GITLEAKS=1 but gitleaks is not installed');
  });
  beforeEach((ctx) => {
    if (!hasGitleaks) ctx.skip();
    dir = mkdtempSync(join(tmpdir(), 'kg-gitleaks-'));
  });
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it.each([
    ['a SurrealDB Cloud hostname', () => `KG_DB_URL=wss://${['abc-123', 'aws-xyz1', 'surreal', 'cloud'].join('.')}/rpc`],
    ['a JWT secret', () => `KG_JWT_SECRET=${random()}`],
    ['a signin secret in JSON', () => `{"KG_SIGNIN_SECRET": "${random()}"}`],
    ['a purge job secret', () => `PURGE_JOB_SECRET: ${random()}`],
    ['a database password', () => `KG_DB_PASS=${random(12)}`],
    ['a Cohere key', () => `COHERE_API_KEY=${random(30)}`],
    ['a Jina key', () => `key = "${['jina', random(30).replace(/[-_]/g, 'x')].join('_')}"`],
    ['a Voyage key', () => `token: ${['pa', random(40)].join('-')}`],
    ['a Logtail token', () => `LOGTAIL_TOKEN=${random(18).replace(/[-_]/g, 'x')}`],
  ])('flags %s', (_name, make) => {
    const res = scan(make());
    expect(res.status, res.stdout + res.stderr).toBe(1);
  });

  it.each([
    ['the .env.example placeholder', 'KG_JWT_SECRET=replace-with-at-least-32-random-characters'],
    ['a your-key placeholder', 'COHERE_API_KEY=your-cohere-api-key-goes-here-0000'],
    ['an environment reference', 'KG_JWT_SECRET=${KG_JWT_SECRET}'],
    ['a secret-store reference', 'KG_DB_PASS=$(secret-store-read kg-db)'],
    ['a throwaway local credential', ['KG_DB_PASS', 'root'].join('=')],
    ['a documented test secret', "KG_JWT_SECRET: 'unit-test-secret-at-least-32-characters!!'"],
    ['a zod schema line', 'KG_DB_PASS: z.string(),'],
  ])('allows %s', (_name, content) => {
    const res = scan(content + '\n');
    expect(res.status, res.stdout + res.stderr).toBe(0);
  });
});
