#!/usr/bin/env tsx
/**
 * One-time script to warm up cold but highly-connected nodes.
 * Spreads activation to neighbors of these "hub" nodes.
 */
import { Surreal } from 'surrealdb';

const ACTIVATION_CEILING = 0.85;
const WARM_FACTOR = 0.3; // How much to boost cold hubs
const SPREAD_FACTOR = 0.15; // How much neighbors get

async function main() {
  const db = new Surreal();
  await db.connect(process.env.KG_DB_URL!);
  await db.authenticate(process.env.KG_DB_TOKEN!);
  await db.use({ namespace: 'kg', database: 'main' });

  // Find cold nodes (decay < 0.1) with many edges (> 10)
  console.log('Finding cold hub nodes...');

  const inEdges = await db.query<{ node: string; count: number }[]>(`
    SELECT out as node, count() as count FROM edge GROUP BY out
  `);
  const outEdges = await db.query<{ node: string; count: number }[]>(`
    SELECT in as node, count() as count FROM edge GROUP BY in
  `);

  const edgeCounts = new Map<string, number>();
  for (const e of inEdges.flat()) {
    const id = String(e.node);
    edgeCounts.set(id, (edgeCounts.get(id) ?? 0) + e.count);
  }
  for (const e of outEdges.flat()) {
    const id = String(e.node);
    edgeCounts.set(id, (edgeCounts.get(id) ?? 0) + e.count);
  }

  const coldNodes = await db.query<{ id: string; decay_score: number }[]>(`
    SELECT id, decay_score FROM node WHERE decay_score < 0.1
  `);

  const coldHubs = coldNodes.flat()
    .map(n => ({
      id: String(n.id),
      decay_score: n.decay_score,
      edges: edgeCounts.get(String(n.id)) ?? 0
    }))
    .filter(n => n.edges >= 10)
    .sort((a, b) => b.edges - a.edges);

  console.log(`Found ${coldHubs.length} cold hubs (decay < 0.1, edges >= 10)`);
  console.log('');

  if (coldHubs.length === 0) {
    console.log('No cold hubs to warm up!');
    await db.close();
    return;
  }

  // Show top 10
  console.log('Top cold hubs:');
  for (const hub of coldHubs.slice(0, 10)) {
    console.log(`  ${hub.id}: decay=${hub.decay_score.toFixed(4)}, edges=${hub.edges}`);
  }
  console.log('');

  // Warm them up
  console.log(`Warming ${coldHubs.length} cold hubs...`);

  let warmedNodes = 0;
  let spreadNodes = 0;

  for (const hub of coldHubs) {
    const nodeId = hub.id.replace('node:', '');
    const newScore = hub.decay_score + (ACTIVATION_CEILING - hub.decay_score) * WARM_FACTOR;

    // Warm the hub
    await db.query(`
      UPDATE type::record('node', $node_id) SET
        decay_score = $new_score,
        last_activated = time::now()
    `, { node_id: nodeId, new_score: newScore });
    warmedNodes++;

    // Native graph traversal for TYPE RELATION edges
    // ->edge->node traverses to neighbors in one expression
    const result = await db.query<{ count: number }[]>(`
      LET $node = type::record('node', $node_id);
      LET $result = (SELECT ->edge->node AS out_n, <-edge<-node AS in_n FROM $node)[0];
      LET $neighbors = array::distinct(array::concat($result.out_n ?? [], $result.in_n ?? []));
      UPDATE node SET
        decay_score = math::min([
          decay_score + ($ceiling - decay_score) * $factor,
          $ceiling
        ]),
        last_activated = time::now()
      WHERE id IN $neighbors;
      RETURN { count: array::len($neighbors) };
    `, {
      node_id: nodeId,
      ceiling: ACTIVATION_CEILING,
      factor: SPREAD_FACTOR
    });

    spreadNodes += result.flat().find(r => r?.count)?.count ?? 0;

    if (warmedNodes % 100 === 0) {
      console.log(`  Progress: ${warmedNodes}/${coldHubs.length} hubs warmed`);
    }
  }

  console.log('');
  console.log(`Done! Warmed ${warmedNodes} hub nodes, spread to ${spreadNodes} neighbors.`);

  // Show new distribution
  const newDist = await db.query<{ bucket: string; count: number }[]>(`
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
  `);

  console.log('');
  console.log('New distribution:');
  for (const b of newDist.flat()) {
    console.log(`  ${b.bucket}: ${b.count}`);
  }

  await db.close();
}

main().catch(console.error);
