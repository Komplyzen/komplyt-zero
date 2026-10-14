#!/usr/bin/env tsx
/**
 * Smoke test: verifies benchmark code compiles and runs without DB.
 * Uses a mock client that returns empty results.
 */

import type { KgDbClient } from '../contracts.js';
import { getHealthMetrics, checkCoherence, checkDrift } from './lib/kg-client.js';
import { runPerfBenchmarks, formatPerfResults } from './perf/latency.js';
import { formatHealthMetrics, formatDriftResults, assessHealth } from './health/metrics.js';
import type { Baseline } from './lib/types.js';

const mockDb: KgDbClient = {
  async query<T>(): Promise<T[]> {
    return [] as T[];
  },
  async queryOne<T>(): Promise<T | null> {
    return null;
  },
  async close(): Promise<void> {},
};

const mockBaseline: Baseline = {
  version: '1.0.0',
  timestamp: '2026-01-01T00:00:00Z',
  gitSha: 'test',
  coherenceMean: 0.6,
  coherenceStdDev: 0.15,
  embeddingCoverage: 95,
  decayDistribution: { cold: 50, cooling: 10, warm: 15, hot: 15, active: 10 },
  perfP99: {},
};

async function smoke(): Promise<void> {
  console.log('Running smoke test (mock DB)...\n');

  console.log('1. Health metrics...');
  const health = await getHealthMetrics(mockDb);
  console.log(formatHealthMetrics(health));
  console.log('');

  const assessment = assessHealth(health);
  console.log(`Assessment: ${assessment.status}`);
  if (assessment.issues.length > 0) {
    for (const issue of assessment.issues) {
      console.log(`  - ${issue}`);
    }
  }
  console.log('');

  console.log('2. Coherence check...');
  const coherence = await checkCoherence(mockDb, 10);
  console.log(`Mean: ${coherence.mean}, StdDev: ${coherence.stdDev}, Samples: ${coherence.samples}`);
  console.log('');

  console.log('3. Drift detection...');
  const drift = checkDrift(health, coherence, mockBaseline);
  console.log(formatDriftResults(drift));
  console.log('');

  console.log('4. Performance benchmarks (mock - will be fast)...');
  const perf = await runPerfBenchmarks(mockDb, async () => new Array(1024).fill(0));
  console.log(formatPerfResults(perf));
  console.log('');

  console.log('Smoke test passed!');
}

smoke().catch(err => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
