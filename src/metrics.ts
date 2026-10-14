import { Hono } from 'hono';

interface Metrics {
  httpRequestsTotal: Map<string, number>;
  httpRequestDurationSeconds: number[];
  dbQueryDurationSeconds: number[];
  embedRequestDurationSeconds: number[];
  sessionPruneRemovedTotal: number;
  sessionPruneFailuresTotal: number;
  sessionPruneLastSuccessSeconds: number;
  sessionRows: number | null;
}

const metrics: Metrics = {
  httpRequestsTotal: new Map(),
  httpRequestDurationSeconds: [],
  dbQueryDurationSeconds: [],
  embedRequestDurationSeconds: [],
  sessionPruneRemovedTotal: 0,
  sessionPruneFailuresTotal: 0,
  sessionPruneLastSuccessSeconds: 0,
  sessionRows: null,
};

const MAX_SAMPLES = 10_000;

export function recordRequest(method: string, path: string, status: number): void {
  const key = `${method}:${path}:${status}`;
  metrics.httpRequestsTotal.set(key, (metrics.httpRequestsTotal.get(key) || 0) + 1);
}

export function recordDuration(type: 'http' | 'db' | 'embed', durationMs: number): void {
  const bucket =
    type === 'http'
      ? metrics.httpRequestDurationSeconds
      : type === 'db'
        ? metrics.dbQueryDurationSeconds
        : metrics.embedRequestDurationSeconds;

  bucket.push(durationMs / 1000);
  if (bucket.length > MAX_SAMPLES) bucket.shift();
}

export function recordSessionPrune(removed: number, remaining?: number): void {
  if (remaining !== undefined) metrics.sessionRows = remaining;
  metrics.sessionPruneRemovedTotal += removed;
  metrics.sessionPruneLastSuccessSeconds = Math.floor(Date.now() / 1000);
}

export function recordSessionPruneFailure(): void {
  metrics.sessionPruneFailuresTotal += 1;
}

function formatHistogram(name: string, bucket: number[]): string {
  if (bucket.length === 0) return '';

  const sum = bucket.reduce((a, b) => a + b, 0);
  const avg = sum / bucket.length;

  return [
    `# HELP ${name} Request duration in seconds`,
    `# TYPE ${name} summary`,
    `${name}_sum ${sum.toFixed(6)}`,
    `${name}_count ${bucket.length}`,
    `${name}_avg ${avg.toFixed(6)}`,
  ].join('\n');
}

export function createMetricsRoute(): Hono {
  const routes = new Hono();

  routes.get('/', (c) => {
    const lines: string[] = [];

    // http_requests_total
    lines.push('# HELP http_requests_total Total HTTP requests');
    lines.push('# TYPE http_requests_total counter');
    for (const [key, count] of metrics.httpRequestsTotal) {
      const [method, path, status] = key.split(':');
      lines.push(`http_requests_total{method="${method}",path="${path}",status="${status}"} ${count}`);
    }

    // Duration histograms
    const httpHist = formatHistogram('http_request_duration_seconds', metrics.httpRequestDurationSeconds);
    if (httpHist) lines.push(httpHist);

    const dbHist = formatHistogram('db_query_duration_seconds', metrics.dbQueryDurationSeconds);
    if (dbHist) lines.push(dbHist);

    const embedHist = formatHistogram('embed_request_duration_seconds', metrics.embedRequestDurationSeconds);
    if (embedHist) lines.push(embedHist);

    lines.push('# HELP kg_session_prune_removed_total kg_auth_session rows deleted by the pruner');
    lines.push('# TYPE kg_session_prune_removed_total counter');
    lines.push(`kg_session_prune_removed_total ${metrics.sessionPruneRemovedTotal}`);
    lines.push('# HELP kg_session_prune_failures_total Failed kg_auth_session prune runs');
    lines.push('# TYPE kg_session_prune_failures_total counter');
    lines.push(`kg_session_prune_failures_total ${metrics.sessionPruneFailuresTotal}`);
    if (metrics.sessionRows !== null) {
      lines.push('# HELP kg_session_rows kg_auth_session rows left after the last completed prune run (should stay flat; a rising value means the pruner is not keeping up or matching nothing)');
      lines.push('# TYPE kg_session_rows gauge');
      lines.push(`kg_session_rows ${metrics.sessionRows}`);
    }
    lines.push('# HELP kg_session_prune_last_success_timestamp_seconds Unix time of the last successful prune run (0 = none yet)');
    lines.push('# TYPE kg_session_prune_last_success_timestamp_seconds gauge');
    lines.push(`kg_session_prune_last_success_timestamp_seconds ${metrics.sessionPruneLastSuccessSeconds}`);

    return c.text(lines.join('\n') + '\n', 200, { 'Content-Type': 'text/plain; charset=utf-8' });
  });

  return routes;
}
