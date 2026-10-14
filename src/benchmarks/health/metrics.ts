import type { HealthMetrics, DriftResult } from '../lib/types.js';

export function formatHealthMetrics(metrics: HealthMetrics): string {
  const lines = ['## Graph Health Metrics', ''];

  lines.push('### Node Counts');
  lines.push(`- **Total nodes**: ${metrics.nodeCount}`);
  lines.push(`- **Total edges**: ${metrics.edgeCount}`);
  lines.push(`- **Edge density**: ${metrics.edgeDensity.toFixed(2)} edges/node`);
  lines.push('');

  lines.push('### By Type');
  for (const [type, count] of Object.entries(metrics.nodesByType).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / metrics.nodeCount) * 100).toFixed(1);
    lines.push(`- ${type}: ${count} (${pct}%)`);
  }
  lines.push('');

  lines.push('### Coverage & Quality');
  lines.push(`- **Embedding coverage**: ${metrics.embeddingCoverage.toFixed(1)}%`);
  lines.push(`- **Orphan nodes**: ${metrics.orphanNodes} (${metrics.orphanPercent.toFixed(1)}%)`);
  lines.push('');

  lines.push('### Decay Distribution');
  const d = metrics.decayDistribution;
  const total = d.cold + d.cooling + d.warm + d.hot + d.active;
  const pct = (n: number) => (total > 0 ? ((n / total) * 100).toFixed(1) : '0.0');
  lines.push(`- Cold (≤0.0001): ${d.cold} (${pct(d.cold)}%)`);
  lines.push(`- Cooling (0.01-0.1): ${d.cooling} (${pct(d.cooling)}%)`);
  lines.push(`- Warm (0.1-0.5): ${d.warm} (${pct(d.warm)}%)`);
  lines.push(`- Hot (0.5-0.85): ${d.hot} (${pct(d.hot)}%)`);
  lines.push(`- Active (≥0.85): ${d.active} (${pct(d.active)}%) — recently activated`);
  lines.push('');

  lines.push('### Session Activity');
  lines.push(`- **Total sessions**: ${metrics.sessionActivity.totalSessions ?? 'n/a'}`);

  return lines.join('\n');
}

export function formatDriftResults(results: DriftResult[]): string {
  const lines = ['## Drift Detection', ''];
  lines.push('| Metric | Current | Baseline | Delta | Status |');
  lines.push('|--------|---------|----------|-------|--------|');

  for (const r of results) {
    const statusIcon = r.status === 'ok' ? '✓' : r.status === 'warning' ? '⚠' : '✗';
    const deltaStr = r.deltaPercent >= 0 ? `+${r.deltaPercent.toFixed(1)}%` : `${r.deltaPercent.toFixed(1)}%`;
    const note = r.note ? ` (${r.note})` : '';
    lines.push(
      `| ${r.metric} | ${r.current.toFixed(2)} | ${r.baseline.toFixed(2)} | ${deltaStr} | ${statusIcon} ${r.status}${note} |`
    );
  }

  const worst = results.reduce((w, r) => {
    if (r.status === 'critical') return 'critical';
    if (r.status === 'warning' && w !== 'critical') return 'warning';
    return w;
  }, 'ok' as 'ok' | 'warning' | 'critical');

  lines.push('');
  lines.push(`**Overall status**: ${worst}`);

  return lines.join('\n');
}

export function assessHealth(metrics: HealthMetrics): { status: 'healthy' | 'warning' | 'critical'; issues: string[] } {
  const issues: string[] = [];

  if (metrics.embeddingCoverage < 90) {
    issues.push(`CRITICAL: Embedding coverage at ${metrics.embeddingCoverage.toFixed(1)}% (<90%)`);
  } else if (metrics.embeddingCoverage < 95) {
    issues.push(`WARNING: Embedding coverage at ${metrics.embeddingCoverage.toFixed(1)}% (<95%)`);
  }

  if (metrics.orphanPercent > 15) {
    issues.push(`CRITICAL: ${metrics.orphanPercent.toFixed(1)}% orphan nodes (>15%)`);
  } else if (metrics.orphanPercent > 10) {
    issues.push(`WARNING: ${metrics.orphanPercent.toFixed(1)}% orphan nodes (>10%)`);
  }

  // Flag if nothing is active (would mean no recent work)
  const activePercent = (metrics.decayDistribution.active / metrics.nodeCount) * 100;
  if (activePercent === 0 && metrics.nodeCount > 100) {
    issues.push(`WARNING: No active nodes — nothing recently activated`);
  }

  if (metrics.edgeDensity < 1) {
    issues.push(`WARNING: Low edge density (${metrics.edgeDensity.toFixed(2)} edges/node)`);
  }

  if ((metrics.sessionActivity.totalSessions ?? 0) === 0 && metrics.nodeCount > 0) {
    issues.push('WARNING: No sessions recorded (session timestamps may not be set)');
  }

  const hasCritical = issues.some(i => i.startsWith('CRITICAL'));
  const hasWarning = issues.some(i => i.startsWith('WARNING'));

  return {
    status: hasCritical ? 'critical' : hasWarning ? 'warning' : 'healthy',
    issues,
  };
}
