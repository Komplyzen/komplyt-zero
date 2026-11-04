/**
 * scripts/check-version-pins.sh must fail when a pinned version drifts, and also when a place it
 * should check has disappeared (a renamed file must not turn the guard into a no-op).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'scripts', 'check-version-pins.sh');

let repo: string;

function put(path: string, content: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}
function check() {
  return spawnSync('sh', ['scripts/check-version-pins.sh'], { cwd: repo, encoding: 'utf8' });
}

describe('scripts/check-version-pins.sh', () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'kg-pins-'));
    mkdirSync(join(repo, 'scripts'));
    copyFileSync(SCRIPT, join(repo, 'scripts', 'check-version-pins.sh'));
    put('src/Dockerfile', 'FROM oven/bun:1.4.3@sha256:aa AS builder\nFROM oven/bun:1.4.3-slim@sha256:bb\n');
    put('docker-compose.yml', '    image: surrealdb/surrealdb:v3.2.4@sha256:cc\n');
    put('.github/workflows/ci.yml', '        with:\n          bun-version: 1.4.3\n  surrealdb/surrealdb:v3.2.4 start\n');
    put('scripts/local-db.sh', 'SURREAL_IMAGE="${SURREAL_IMAGE:-surrealdb/surrealdb:v3.2.4}"\n');
    put('bench/lib.sh', 'SURREAL_IMAGE="${SURREAL_IMAGE:-surrealdb/surrealdb:v3.2.4}"\n');
    put('docs/self-hosting.md', 'The script starts `surrealdb/surrealdb:v3.2.4` on 127.0.0.1.\n');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('passes when every pin agrees with its source of truth', () => {
    const res = check();
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toContain('ok');
  });

  it('fails and names file and line when a workflow Bun pin drifts', () => {
    put('.github/workflows/ci.yml', '        with:\n          bun-version: 1.4.2\n  surrealdb/surrealdb:v3.2.4 start\n');
    const res = check();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('.github/workflows/ci.yml:2 has 1.4.2, src/Dockerfile has 1.4.3');
  });

  it('fails when the slim Dockerfile stage differs from the builder stage', () => {
    put('src/Dockerfile', 'FROM oven/bun:1.4.3@sha256:aa AS builder\nFROM oven/bun:1.4.4-slim@sha256:bb\n');
    const res = check();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('src/Dockerfile:2 has 1.4.4');
  });

  it.each([
    ['a workflow', '.github/workflows/ci.yml', '        with:\n          bun-version: 1.4.3\n  surrealdb/surrealdb:v3.1.0 start\n'],
    ['a local script', 'scripts/local-db.sh', 'SURREAL_IMAGE="${SURREAL_IMAGE:-surrealdb/surrealdb:v3.0.0}"\n'],
    ['the bench library', 'bench/lib.sh', 'SURREAL_IMAGE="${SURREAL_IMAGE:-surrealdb/surrealdb:v3.0.0}"\n'],
    ['the docs', 'docs/self-hosting.md', 'The script starts `surrealdb/surrealdb:v3.0.0` on 127.0.0.1.\n'],
  ])('fails when the SurrealDB tag in %s drifts from the compose file', (_name, path, content) => {
    put(path, content);
    const res = check();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`${path}:`);
    expect(res.stderr).toContain('docker-compose.yml has 3.2.4');
  });

  it('fails when the source of truth no longer has a pin', () => {
    put('docker-compose.yml', '    image: surrealdb/surrealdb:latest\n');
    const res = check();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("no 'surrealdb/surrealdb:v<version>' in docker-compose.yml");
  });

  it.each([
    ['a quoted Bun pin', '.github/workflows/ci.yml', '          bun-version: "1.4.3"\n  surrealdb/surrealdb:v3.2.4 start\n', 'bun-version: "1.4.3"'],
    ['a Bun pin of latest', '.github/workflows/ci.yml', '          bun-version: latest\n  surrealdb/surrealdb:v3.2.4 start\n', 'bun-version: latest'],
    ['a two-part SurrealDB tag', 'scripts/local-db.sh', 'SURREAL_IMAGE="${SURREAL_IMAGE:-surrealdb/surrealdb:v3.2}"\n', 'surrealdb/surrealdb:v3.2'],
    ['an unpinned SurrealDB image', 'bench/lib.sh', 'SURREAL_IMAGE="${SURREAL_IMAGE:-surrealdb/surrealdb:latest}"\n', 'surrealdb/surrealdb:latest'],
  ])('fails on %s instead of skipping it', (_name, path, content, shown) => {
    put(path, content);
    // Keep one valid pin per set so "found nothing" cannot be what fails.
    if (path.endsWith('ci.yml') === false) put('.github/workflows/ci.yml', '          bun-version: 1.4.3\n  surrealdb/surrealdb:v3.2.4 start\n');
    const res = check();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('not a plain X.Y.Z pin');
    expect(res.stderr).toContain(shown);
  });

  it('fails when a file it should check has gone missing', () => {
    rmSync(join(repo, 'bench', 'lib.sh'));
    const res = check();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('bench/lib.sh does not exist');
  });

  it('fails when no workflow pins Bun any more (the check cannot pass by finding nothing)', () => {
    put('.github/workflows/ci.yml', '  surrealdb/surrealdb:v3.2.4 start\n');
    const res = check();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("no 'bun-version: <version>' found");
  });
});
