import { Surreal } from 'surrealdb';
import { KgDbClient, extractRecordId } from '../../contracts.js';
import type { HealthMetrics, DriftResult, Baseline } from './types.js';

export interface BenchmarkDbConfig {
  url: string;
  user?: string;
  pass?: string;
  token?: string;
  ns: string;
  db: string;
}

export function configFromEnv(): BenchmarkDbConfig {
  return {
    url: process.env.KG_DB_URL ?? 'ws://localhost:8000',
    user: process.env.KG_DB_USER,
    pass: process.env.KG_DB_PASS,
    token: process.env.KG_DB_TOKEN,
    ns: process.env.KG_DB_NS ?? 'kg',
    db: process.env.KG_DB_NAME ?? 'main',
  };
}

export async function createBenchmarkClient(
  config: BenchmarkDbConfig
): Promise<KgDbClient & { raw: Surreal }> {
  const db = new Surreal();
  await db.connect(config.url);

  if (config.token) {
    await db.authenticate(config.token);
  } else if (config.user && config.pass) {
    await db.signin({ username: config.user, password: config.pass });
  }

  await db.use({ namespace: config.ns, database: config.db });

  return {
    raw: db,
    async query<T>(sql: string, vars?: Record<string, unknown>): Promise<T[]> {
      const result = await db.query<T[][]>(sql, vars);
      return result.flat();
    },
    async queryOne<T>(sql: string, vars?: Record<string, unknown>): Promise<T | null> {
      const result = await db.query<T[][]>(sql, vars);
      return result.flat()[0] ?? null;
    },
    async close(): Promise<void> {
      await db.close();
    },
  };
}

export async function getHealthMetrics(db: KgDbClient): Promise<HealthMetrics> {
  const [
    nodeCount,
    nodesByType,
    nodesByProject,
    edgeCount,
    orphanCount,
    embeddingCount,
    decayStats,
    sessionStats,
  ] = await Promise.all([
    db.queryOne<{ count: number }>('SELECT count() as count FROM node GROUP ALL'),
    db.query<{ type: string; count: number }>('SELECT type, count() as count FROM node GROUP BY type'),
    db.query<{ project: string; count: number }>('SELECT project, count() as count FROM node GROUP BY project'),
    db.queryOne<{ count: number }>('SELECT count() as count FROM edge GROUP ALL'),
    Promise.resolve({ count: 0 }),
    db.queryOne<{ count: number }>('SELECT count() as count FROM node WHERE embedding IS NOT NONE GROUP ALL'),
    db.query<{ bucket: string; count: number }>(`
      SELECT
        IF decay_score <= 0.0001 THEN 'cold'
        ELSE IF decay_score <= 0.1 THEN 'cooling'
        ELSE IF decay_score <= 0.5 THEN 'warm'
        ELSE IF decay_score < 0.85 THEN 'hot'
        ELSE 'active'
        END as bucket,
        count() as count
      FROM node
      GROUP BY bucket
    `),
    db.queryOne<{ total: number }>(`SELECT count() as total FROM session GROUP ALL`),
  ]);

  const total = nodeCount?.count ?? 0;
  const orphans = orphanCount?.count ?? 0;
  const withEmbedding = embeddingCount?.count ?? 0;

  const typeMap: Record<string, number> = {};
  for (const row of nodesByType) {
    typeMap[row.type] = row.count;
  }

  const projectMap: Record<string, number> = {};
  for (const row of nodesByProject) {
    const projectId = row.project ? extractRecordId(row.project, 'project') : 'none';
    projectMap[projectId] = row.count;
  }

  const decayDist = { cold: 0, cooling: 0, warm: 0, hot: 0, active: 0 };
  for (const row of decayStats) {
    const bucket = row.bucket as keyof typeof decayDist;
    if (bucket in decayDist) {
      decayDist[bucket] = row.count;
    }
  }

  return {
    nodeCount: total,
    nodesByType: typeMap,
    nodesByProject: projectMap,
    edgeCount: edgeCount?.count ?? 0,
    edgeDensity: total > 0 ? (edgeCount?.count ?? 0) / total : 0,
    orphanNodes: orphans,
    orphanPercent: total > 0 ? (orphans / total) * 100 : 0,
    embeddingCoverage: total > 0 ? (withEmbedding / total) * 100 : 100,
    decayDistribution: decayDist,
    sessionActivity: {
      lastSession: 'n/a',
      sessionsLast7d: 0,
      sessionsLast30d: 0,
      totalSessions: sessionStats?.total ?? 0,
    },
    timestamp: new Date().toISOString(),
  };
}

export async function checkCoherence(
  db: KgDbClient,
  sampleSize = 100
): Promise<{ mean: number; stdDev: number; samples: number }> {
  const pairs = await db.query<{ similarity: number }>(`
    SELECT
      vector::similarity::cosine(in.embedding, out.embedding) as similarity
    FROM edge
    WHERE in.embedding IS NOT NONE AND out.embedding IS NOT NONE
    LIMIT ${sampleSize}
  `);

  if (pairs.length === 0) {
    return { mean: 1.0, stdDev: 0, samples: 0 };
  }

  const similarities = pairs.map(p => p.similarity).filter(s => s != null);
  if (similarities.length === 0) {
    return { mean: 1.0, stdDev: 0, samples: 0 };
  }

  const mean = similarities.reduce((a, b) => a + b, 0) / similarities.length;
  const variance = similarities.reduce((sum, s) => sum + (s - mean) ** 2, 0) / similarities.length;
  const stdDev = Math.sqrt(variance);

  return { mean, stdDev, samples: similarities.length };
}

export function checkDrift(
  current: HealthMetrics,
  coherence: { mean: number; stdDev: number; samples: number },
  baseline: Baseline
): DriftResult[] {
  const results: DriftResult[] = [];

  if (current.nodeCount === 0) {
    results.push({
      metric: 'embedding_coverage',
      current: 0,
      baseline: baseline.embeddingCoverage,
      delta: 0,
      deltaPercent: 0,
      status: 'ok',
      threshold: { warning: 95, critical: 90 },
      note: 'skipped: empty database',
    });
    results.push({
      metric: 'semantic_coherence',
      current: 0,
      baseline: baseline.coherenceMean,
      delta: 0,
      deltaPercent: 0,
      status: 'ok',
      threshold: { warning: 5, critical: 10 },
      note: 'skipped: empty database',
    });
    results.push({
      metric: 'cold_nodes',
      current: 0,
      baseline: 0,
      delta: 0,
      deltaPercent: 0,
      status: 'ok',
      threshold: { warning: 90, critical: 95 },
      note: 'skipped: empty database',
    });
    results.push({
      metric: 'orphan_nodes',
      current: 0,
      baseline: 5,
      delta: 0,
      deltaPercent: 0,
      status: 'ok',
      threshold: { warning: 10, critical: 15 },
      note: 'skipped: empty database',
    });
    return results;
  }

  const embDelta = current.embeddingCoverage - baseline.embeddingCoverage;
  results.push({
    metric: 'embedding_coverage',
    current: current.embeddingCoverage,
    baseline: baseline.embeddingCoverage,
    delta: embDelta,
    deltaPercent: (embDelta / baseline.embeddingCoverage) * 100,
    status: current.embeddingCoverage < 90 ? 'critical' : current.embeddingCoverage < 95 ? 'warning' : 'ok',
    threshold: { warning: 95, critical: 90 },
  });

  if (coherence.samples === 0) {
    results.push({
      metric: 'semantic_coherence',
      current: 0,
      baseline: baseline.coherenceMean,
      delta: 0,
      deltaPercent: 0,
      status: 'ok',
      threshold: { warning: 5, critical: 10 },
      note: 'skipped: no edge pairs with embeddings',
    });
  } else {
    const cohDeltaPercent = ((coherence.mean - baseline.coherenceMean) / baseline.coherenceMean) * 100;
    results.push({
      metric: 'semantic_coherence',
      current: coherence.mean,
      baseline: baseline.coherenceMean,
      delta: coherence.mean - baseline.coherenceMean,
      deltaPercent: cohDeltaPercent,
      status: Math.abs(cohDeltaPercent) > 10 ? 'critical' : Math.abs(cohDeltaPercent) > 5 ? 'warning' : 'ok',
      threshold: { warning: 5, critical: 10 },
    });
  }

  const coldPercent = current.nodeCount > 0 ? (current.decayDistribution.cold / current.nodeCount) * 100 : 0;
  const baselineColdPercent = current.nodeCount > 0 ? (baseline.decayDistribution.cold / current.nodeCount) * 100 : 0;
  results.push({
    metric: 'cold_nodes',
    current: coldPercent,
    baseline: baselineColdPercent,
    delta: coldPercent - baselineColdPercent,
    deltaPercent: baselineColdPercent > 0 ? ((coldPercent - baselineColdPercent) / baselineColdPercent) * 100 : 0,
    status: 'ok',
    threshold: { warning: 90, critical: 95 },
  });

  results.push({
    metric: 'orphan_nodes',
    current: current.orphanPercent,
    baseline: 5,
    delta: current.orphanPercent - 5,
    deltaPercent: ((current.orphanPercent - 5) / 5) * 100,
    status: current.orphanPercent > 15 ? 'critical' : current.orphanPercent > 10 ? 'warning' : 'ok',
    threshold: { warning: 10, critical: 15 },
  });

  return results;
}
