#!/usr/bin/env tsx
import { Surreal } from 'surrealdb';

async function main() {
  const db = new Surreal();
  await db.connect(process.env.KG_DB_URL!);
  await db.authenticate(process.env.KG_DB_TOKEN!);
  await db.use({ namespace: 'kg', database: 'main' });

  // Get decay scores for nodes that have been activated
  const scores = await db.query<{ decay_score: number }[]>(`
    SELECT decay_score
    FROM node
    WHERE session_activated IS NOT NONE
    ORDER BY decay_score ASC
  `);

  const flat = scores.flat().map(n => n.decay_score).filter(s => s != null);
  console.log('Activated nodes:', flat.length);
  console.log('');

  // Histogram with finer buckets
  const buckets = [0, 0.01, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0];
  const counts: number[] = new Array(buckets.length).fill(0);

  for (const s of flat) {
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (s >= buckets[i]) {
        counts[i]++;
        break;
      }
    }
  }

  console.log('Distribution (activated nodes only):');
  for (let i = 0; i < buckets.length; i++) {
    const lo = buckets[i];
    const hi = buckets[i + 1] ?? 1.01;
    const count = counts[i];
    const pct = ((count / flat.length) * 100).toFixed(1);
    const bar = '█'.repeat(Math.ceil(count / 5));
    console.log(`  ${lo.toFixed(2)}-${hi.toFixed(2)}: ${count.toString().padStart(4)} (${pct.padStart(5)}%) ${bar}`);
  }

  // Stats
  const min = Math.min(...flat);
  const max = Math.max(...flat);
  const mean = flat.reduce((a, b) => a + b, 0) / flat.length;
  const sorted = [...flat].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  console.log('');
  console.log('Stats:');
  console.log('  Min:', min.toFixed(4));
  console.log('  Max:', max.toFixed(4));
  console.log('  Mean:', mean.toFixed(4));
  console.log('  Median:', median.toFixed(4));

  await db.close();
}

main().catch(console.error);
