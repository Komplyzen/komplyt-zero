#!/usr/bin/env tsx
import { Surreal } from 'surrealdb';

async function debug() {
  const db = new Surreal();
  await db.connect(process.env.KG_DB_URL!);
  await db.authenticate(process.env.KG_DB_TOKEN!);
  await db.use({ namespace: 'kg', database: 'main' });

  console.log('=== Edge check ===');
  const edgeCount = await db.query('SELECT count() FROM edge GROUP ALL');
  console.log('Edge count:', edgeCount);

  const sample = await db.query('SELECT in, out FROM edge LIMIT 3');
  console.log('Sample edges:', JSON.stringify(sample, null, 2));

  console.log('\n=== Session check ===');
  const sessions = await db.query('SELECT id, started_at FROM session ORDER BY started_at DESC LIMIT 3');
  console.log('Recent sessions:', JSON.stringify(sessions, null, 2));

  console.log('\n=== Recent nodes ===');
  const recent = await db.query('SELECT id, decay_score, created_at FROM node ORDER BY created_at DESC LIMIT 3');
  console.log('Recent nodes:', JSON.stringify(recent, null, 2));

  console.log('\n=== Orphan check ===');
  // The issue: array::len(<-edge) syntax may not work as expected
  const orphanOld = await db.query('SELECT count() as count FROM node WHERE array::len(<-edge) = 0 AND array::len(->edge) = 0 GROUP ALL');
  console.log('Orphans (old method):', orphanOld);

  // Better check: nodes not referenced in any edge
  const orphanNew = await db.query(`
    LET $in_edges = (SELECT VALUE in FROM edge);
    LET $out_edges = (SELECT VALUE out FROM edge);
    LET $connected = array::distinct(array::concat($in_edges, $out_edges));
    SELECT count() FROM node WHERE id NOT IN $connected GROUP ALL
  `);
  console.log('Orphans (new method):', orphanNew);

  await db.close();
}

debug().catch(console.error);
