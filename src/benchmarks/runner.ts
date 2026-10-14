#!/usr/bin/env tsx
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createProviderFromEnv } from '../embed.js';
import { embeddingEnvSchema } from '../env-embedding.js';
import { formatEnvIssues } from '../env-helpers.js';
import {
  createBenchmarkClient,
  configFromEnv,
  getHealthMetrics,
  checkCoherence,
  checkDrift,
} from './lib/kg-client.js';
import { runPerfBenchmarks, formatPerfResults } from './perf/latency.js';
import { formatHealthMetrics, formatDriftResults, assessHealth } from './health/metrics.js';
import type { BenchmarkReport, Baseline, HealthMetrics } from './lib/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');
const BASELINE_PATH = join(RESULTS_DIR, 'baseline.json');

function getGitInfo(): { sha: string; branch: string } {
  try {
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    return { sha, branch };
  } catch {
    return { sha: 'unknown', branch: 'unknown' };
  }
}

function loadBaseline(): Baseline | null {
  if (!existsSync(BASELINE_PATH)) {
    return null;
  }
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

function saveReport(report: BenchmarkReport): string {
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }

  const date = new Date().toISOString().split('T')[0];
  const path = join(RESULTS_DIR, `${date}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));

  const latestPath = join(RESULTS_DIR, 'latest.json');
  writeFileSync(latestPath, JSON.stringify(report, null, 2));

  return path;
}

function formatReport(report: BenchmarkReport): string {
  const lines = [
    `# Benchmark Report`,
    '',
    `**Date**: ${report.timestamp}`,
    `**Git**: ${report.gitBranch} @ ${report.gitSha}`,
    `**Environment**: ${report.environment}`,
    '',
  ];

  if (report.health) {
    lines.push(formatHealthMetrics(report.health));
    lines.push('');
  }

  if (report.drift) {
    lines.push(formatDriftResults(report.drift.results));
    lines.push('');
  }

  if (report.perf) {
    lines.push(formatPerfResults(report.perf.results));
    lines.push('');
  }

  return lines.join('\n');
}

type Suite = 'all' | 'health' | 'drift' | 'perf';

async function run(suites: Suite[] = ['all']): Promise<void> {
  const runAll = suites.includes('all');
  const runHealth = runAll || suites.includes('health');
  const runDrift = runAll || suites.includes('drift');
  const runPerf = runAll || suites.includes('perf');

  console.log('Connecting to database...');
  const config = configFromEnv();
  const db = await createBenchmarkClient(config);

  let embedFn: ((text: string) => Promise<number[]>) | null = null;

  if (runPerf) {
    // Same provider selection as the server (EMBEDDING_PROVIDER, default cohere).
    const embeddingEnv = embeddingEnvSchema.safeParse(process.env);
    if (!embeddingEnv.success) {
      console.warn(
        `Embedding provider not configured, skipping semantic search benchmarks:\n${formatEnvIssues(embeddingEnv.error)}`
      );
    } else if (embeddingEnv.data.EMBEDDING_PROVIDER === 'fixture') {
      // Hash vectors carry no meaning: timings and recall against them measure nothing.
      console.warn('Fixture embedding provider selected, skipping semantic search benchmarks (never measure with fixtures)');
    } else {
      try {
        const embed = await createProviderFromEnv(embeddingEnv.data);
        embedFn = (text: string) => embed.embedQuery(text);
      } catch (err) {
        console.warn(`Embedding provider unavailable, skipping semantic search benchmarks: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const git = getGitInfo();
  const baseline = loadBaseline();

  const report: BenchmarkReport = {
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    gitSha: git.sha,
    gitBranch: git.branch,
    environment: process.env.CI ? 'ci' : 'local',
  };

  let healthMetrics: HealthMetrics | undefined;

  if (runHealth) {
    console.log('Collecting health metrics...');
    healthMetrics = await getHealthMetrics(db);
    report.health = healthMetrics;
    const assessment = assessHealth(healthMetrics);
    console.log(`Health status: ${assessment.status}`);
    if (assessment.issues.length > 0) {
      console.log('Issues:');
      for (const issue of assessment.issues) {
        console.log(`  - ${issue}`);
      }
    }
  }

  if (runDrift) {
    if (!baseline) {
      console.log('No baseline found, skipping drift detection. Run with --save-baseline first.');
    } else {
      console.log('Running drift detection...');
      if (!healthMetrics) {
        healthMetrics = await getHealthMetrics(db);
      }
      const coherence = await checkCoherence(db);
      const driftResults = checkDrift(healthMetrics, coherence, baseline);
      const worst = driftResults.reduce(
        (w, r) => (r.status === 'critical' ? 'critical' : r.status === 'warning' && w !== 'critical' ? 'warning' : w),
        'ok' as 'ok' | 'warning' | 'critical'
      );
      report.drift = { results: driftResults, overallStatus: worst };
      console.log(`Drift status: ${worst}`);
    }
  }

  if (runPerf && embedFn) {
    console.log('Running performance benchmarks...');
    const perfResults = await runPerfBenchmarks(db, embedFn);
    const worst = perfResults.reduce(
      (w, r) => (r.status === 'critical' ? 'critical' : r.status === 'warning' && w !== 'critical' ? 'warning' : w),
      'ok' as 'ok' | 'warning' | 'critical'
    );
    report.perf = { results: perfResults, overallStatus: worst };
    console.log(`Performance status: ${worst}`);
  }

  await db.close();

  const path = saveReport(report);
  console.log(`\nReport saved to: ${path}`);

  console.log('\n' + formatReport(report));

  if (process.argv.includes('--save-baseline')) {
    console.log('\nSaving baseline...');
    const coherence = await checkCoherence(await createBenchmarkClient(config));
    const newBaseline: Baseline = {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      gitSha: git.sha,
      coherenceMean: coherence.mean,
      coherenceStdDev: coherence.stdDev,
      embeddingCoverage: report.health?.embeddingCoverage ?? 100,
      decayDistribution: report.health?.decayDistribution ?? { cold: 0, cooling: 0, warm: 0, hot: 0, active: 0 },
      perfP99: report.perf?.results.reduce((acc, r) => ({ ...acc, [r.operation]: r.p99Ms }), {}) ?? {},
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(newBaseline, null, 2));
    console.log(`Baseline saved to: ${BASELINE_PATH}`);
  }

  const hasCritical =
    report.drift?.overallStatus === 'critical' ||
    report.perf?.overallStatus === 'critical' ||
    (report.health && assessHealth(report.health).status === 'critical');

  if (hasCritical && process.env.CI) {
    console.error('\nCRITICAL issues detected, failing CI');
    process.exit(1);
  }
}

const VALID_SUITES: Suite[] = ['all', 'health', 'drift', 'perf'];
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const suites: Suite[] = args.length > 0
  ? args.filter((a): a is Suite => VALID_SUITES.includes(a as Suite))
  : ['all'];

run(suites).catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
