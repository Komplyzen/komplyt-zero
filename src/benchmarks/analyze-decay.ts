#!/usr/bin/env tsx
import { Surreal } from 'surrealdb';

async function main() {
  const db = new Surreal();
  await db.connect(process.env.KG_DB_URL!);
  await db.authenticate(process.env.KG_DB_TOKEN!);
  await db.use({ namespace: 'kg', database: 'main' });

  // Get edge counts per node
  const inEdges = await db.query<{ node: string; count: number }[]>(`
    SELECT out as node, count() as count FROM edge GROUP BY out
  `);
  const outEdges = await db.query<{ node: string; count: number }[]>(`
    SELECT in as node, count() as count FROM edge GROUP BY in
  `);

  const inMap = new Map(inEdges.flat().map(e => [String(e.node), e.count]));
  const outMap = new Map(outEdges.flat().map(e => [String(e.node), e.count]));

  // Get nodes with their decay score
  const nodeData = await db.query<{ id: string; decay_score: number }[]>(`
    SELECT id, decay_score FROM node
  `);

  const nodes = nodeData.flat().map(n => ({
    id: String(n.id),
    decay_score: n.decay_score,
    in_edges: inMap.get(String(n.id)) ?? 0,
    out_edges: outMap.get(String(n.id)) ?? 0,
  }));

  const flat = nodes.filter(n => n.decay_score != null);
  console.log('Total nodes:', flat.length);
  console.log('');

  // Distribution with new threshold
  const buckets = [0, 0.0001, 0.001, 0.01, 0.1, 0.5, 0.85, 1.0];
  const bucketData: { lo: number; hi: number; count: number; avgEdges: number; nodes: typeof flat }[] = [];

  for (let i = 0; i < buckets.length; i++) {
    const lo = buckets[i];
    const hi = buckets[i + 1] ?? 1.01;
    const inBucket = flat.filter(n => n.decay_score >= lo && n.decay_score < hi);
    const totalEdges = inBucket.reduce((sum, n) => sum + n.in_edges + n.out_edges, 0);
    bucketData.push({
      lo,
      hi,
      count: inBucket.length,
      avgEdges: inBucket.length > 0 ? totalEdges / inBucket.length : 0,
      nodes: inBucket,
    });
  }

  console.log('Decay Distribution (with edge correlation):');
  console.log('─'.repeat(70));
  console.log('Range          │ Nodes  │  %    │ Avg Edges │ Histogram');
  console.log('─'.repeat(70));

  for (const b of bucketData) {
    const pct = ((b.count / flat.length) * 100).toFixed(1).padStart(5);
    const bar = '█'.repeat(Math.ceil(b.count / 30));
    const range = `${b.lo.toFixed(4)}-${b.hi.toFixed(4)}`.padEnd(14);
    console.log(`${range}│ ${b.count.toString().padStart(5)}  │ ${pct}% │ ${b.avgEdges.toFixed(1).padStart(9)} │ ${bar}`);
  }

  console.log('─'.repeat(70));
  console.log('');

  // Correlation analysis
  const withEdges = flat.filter(n => n.in_edges + n.out_edges > 0);
  const withoutEdges = flat.filter(n => n.in_edges + n.out_edges === 0);

  console.log('Edge correlation:');
  console.log(`  Nodes with edges: ${withEdges.length} (avg decay: ${(withEdges.reduce((s, n) => s + n.decay_score, 0) / withEdges.length).toFixed(4)})`);
  console.log(`  Nodes without edges: ${withoutEdges.length} (avg decay: ${(withoutEdges.reduce((s, n) => s + n.decay_score, 0) / withoutEdges.length).toFixed(4)})`);
  console.log('');

  // Quartile analysis by edge count
  const sorted = [...flat].sort((a, b) => (b.in_edges + b.out_edges) - (a.in_edges + a.out_edges));
  const q1 = sorted.slice(0, Math.floor(sorted.length / 4));
  const q4 = sorted.slice(Math.floor(sorted.length * 3 / 4));

  console.log('Decay by connectivity quartile:');
  console.log(`  Top 25% (most connected): avg decay ${(q1.reduce((s, n) => s + n.decay_score, 0) / q1.length).toFixed(4)}, avg edges ${(q1.reduce((s, n) => s + n.in_edges + n.out_edges, 0) / q1.length).toFixed(1)}`);
  console.log(`  Bottom 25% (least connected): avg decay ${(q4.reduce((s, n) => s + n.decay_score, 0) / q4.length).toFixed(4)}, avg edges ${(q4.reduce((s, n) => s + n.in_edges + n.out_edges, 0) / q4.length).toFixed(1)}`);
  console.log('');

  // Sample of high-decay, high-edge nodes
  const highBoth = flat
    .filter(n => n.decay_score >= 0.5 && n.in_edges + n.out_edges >= 10)
    .sort((a, b) => b.decay_score - a.decay_score)
    .slice(0, 5);

  console.log('Sample high-decay + high-edge nodes:');
  for (const n of highBoth) {
    console.log(`  ${n.id}: decay=${n.decay_score.toFixed(4)}, edges=${n.in_edges + n.out_edges}`);
  }

  await db.close();
}

main().catch(console.error);
