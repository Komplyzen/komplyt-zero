import type { KgDbClient } from '../../contracts.js';
import type { PerfResult } from '../lib/types.js';

interface PerfThresholds {
  p50Warning: number;
  p50Critical: number;
  p99Warning: number;
  p99Critical: number;
}

const THRESHOLDS: Record<string, PerfThresholds> = {
  kg_query_semantic: { p50Warning: 2000, p50Critical: 5000, p99Warning: 5000, p99Critical: 10000 },
  kg_query_filter: { p50Warning: 1000, p50Critical: 2000, p99Warning: 2000, p99Critical: 5000 },
  kg_node_create: { p50Warning: 1000, p50Critical: 2000, p99Warning: 3000, p99Critical: 5000 },
  kg_session_start: { p50Warning: 500, p50Critical: 1000, p99Warning: 1000, p99Critical: 2000 },
  kg_relate: { p50Warning: 500, p50Critical: 1000, p99Warning: 1000, p99Critical: 2000 },
  kg_node_update: { p50Warning: 500, p50Critical: 1000, p99Warning: 1000, p99Critical: 2000 },
};

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(samples: number[]): { p50: number; p95: number; p99: number; min: number; max: number; mean: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / samples.length,
  };
}

async function benchmark(
  name: string,
  fn: () => Promise<void>,
  iterations = 20
): Promise<PerfResult> {
  const samples: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }

  const s = stats(samples);
  const thresholds = THRESHOLDS[name] ?? THRESHOLDS.kg_query_semantic;

  let status: 'ok' | 'warning' | 'critical' = 'ok';
  if (s.p99 > thresholds.p99Critical || s.p50 > thresholds.p50Critical) {
    status = 'critical';
  } else if (s.p99 > thresholds.p99Warning || s.p50 > thresholds.p50Warning) {
    status = 'warning';
  }

  return {
    operation: name,
    samples: iterations,
    p50Ms: Math.round(s.p50),
    p95Ms: Math.round(s.p95),
    p99Ms: Math.round(s.p99),
    minMs: Math.round(s.min),
    maxMs: Math.round(s.max),
    meanMs: Math.round(s.mean),
    status,
  };
}

export async function runPerfBenchmarks(
  db: KgDbClient,
  embedFn: (text: string) => Promise<number[]>
): Promise<PerfResult[]> {
  const results: PerfResult[] = [];

  results.push(
    await benchmark('kg_query_filter', async () => {
      await db.query('SELECT * FROM node WHERE type = $type LIMIT 10', { type: 'observation' });
    })
  );

  const testEmbedding = await embedFn('benchmark test query');
  results.push(
    await benchmark('kg_query_semantic', async () => {
      await db.query(
        `SELECT *, vector::similarity::cosine(embedding, $emb) as score
         FROM node
         WHERE embedding IS NOT NONE
         ORDER BY score DESC
         LIMIT 10`,
        { emb: testEmbedding }
      );
    })
  );

  results.push(
    await benchmark('kg_session_start', async () => {
      await db.query(`
        LET $next = (SELECT VALUE session_num FROM session ORDER BY session_num DESC LIMIT 1);
        RETURN $next[0] OR 0;
      `);
    })
  );

  const nodes = await db.query<{ id: string }>('SELECT id FROM node LIMIT 2');
  if (nodes.length >= 2) {
    results.push(
      // Native graph traversal for TYPE RELATION edges
      // Check if edge exists between two nodes
      await benchmark('kg_relate', async () => {
        await db.query(
          'SELECT ->edge[WHERE out = $to] AS edges FROM $from LIMIT 1',
          { from: nodes[0].id, to: nodes[1].id }
        );
      })
    );

    results.push(
      await benchmark('kg_node_update', async () => {
        await db.query('SELECT decay_score FROM $node', { node: nodes[0].id });
      })
    );
  }

  return results;
}

export function formatPerfResults(results: PerfResult[]): string {
  const lines = ['## Performance Benchmarks', ''];
  lines.push('| Operation | P50 | P95 | P99 | Status |');
  lines.push('|-----------|-----|-----|-----|--------|');

  for (const r of results) {
    const statusIcon = r.status === 'ok' ? '✓' : r.status === 'warning' ? '⚠' : '✗';
    lines.push(`| ${r.operation} | ${r.p50Ms}ms | ${r.p95Ms}ms | ${r.p99Ms}ms | ${statusIcon} ${r.status} |`);
  }

  return lines.join('\n');
}
