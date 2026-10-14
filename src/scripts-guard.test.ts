/**
 * The guard that keeps the private meta-model compute out of this repository must actually
 * fail when it should: each probe below is a way the code could come back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'scripts', 'check-no-private-compute.sh');

let repo: string;

function git(...args: string[]) {
  return spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
}
function put(path: string, content: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}
function check() {
  return spawnSync('bash', ['scripts/check-no-private-compute.sh'], { cwd: repo, encoding: 'utf8' });
}

describe('scripts/check-no-private-compute.sh', () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'kg-guard-'));
    git('init', '-q');
    mkdirSync(join(repo, 'scripts'));
    copyFileSync(SCRIPT, join(repo, 'scripts', 'check-no-private-compute.sh'));
    put('src/index.ts', 'export const ok = 1;\n');
    put('database/migrations/000_baseline.surql', 'DEFINE FIELD poincare_magnitude ON node TYPE none | float;\n');
    put('docs/notes.md', 'The meta-model is computed elsewhere.\n');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('passes on a tree without the private compute (the schema may name the poincare columns)', () => {
    const res = check();
    expect(res.status, res.stdout + res.stderr).toBe(0);
  });

  it.each([
    ['a methodology file', 'src/methodology.ts', 'export {}\n'],
    ['a poincare file in another language', 'src/poincare_train.py', 'x = 1\n'],
    ['a renamed variant', 'src/methodology.v2.js', 'export {}\n'],
    ['a resiliency lens file', 'src/lenses/resiliency.ts', 'export {}\n'],
    ['a process model file', 'src/process-model.ts', 'export {}\n'],
    ['trainPoincare', 'src/a.ts', 'export const x = trainPoincare;\n'],
    ['extractMethodology', 'src/a.ts', 'extractMethodology(db);\n'],
    ['savePoincareEmbeddings', 'src/a.ts', 'savePoincareEmbeddings();\n'],
    ['extractResiliencyModel', 'src/a.ts', 'await extractResiliencyModel(db);\n'],
    ['extractProcessModel', 'src/a.ts', 'await extractProcessModel(db);\n'],
    ['getQualityMetrics', 'src/a.ts', 'getQualityMetrics(db);\n'],
    ['determineStatus', 'src/a.ts', 'determineStatus(m);\n'],
  ])('fails on %s', (_name, path, content) => {
    put(path, content);
    const res = check();
    expect(res.status).toBe(1);
    expect(res.stdout).toContain(path.startsWith('src/lenses') ? 'src/lenses/' : path);
  });
});
