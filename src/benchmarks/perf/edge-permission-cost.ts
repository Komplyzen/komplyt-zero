/**
 * One-off measurement for LYT-264: what does a scoped `FOR select` on `edge`
 * cost on the real query shapes? NOT part of CI; run it by hand against a
 * throwaway local SurrealDB that has the migrations applied:
 *
 *   KG_DB_URL=ws://127.0.0.1:8020 KG_DB_USER=root KG_DB_PASS=root KG_DB_NS=kg KG_DB_NAME=test \
 *   KG_JWT_SECRET=local-test-secret-at-least-32-chars EMBEDDING_PROVIDER=fixture \
 *   bun run benchmarks/perf/edge-permission-cost.ts
 *
 * Why it is separate from latency.ts: that harness signs in as root, and root
 * bypasses table permissions, so it would show no difference at all. Here the
 * workloads run through record-user sessions (the `kg_server` access the real
 * server uses, via dbFactory.createScoped) and only the seed and the
 * `DEFINE TABLE OVERWRITE` swaps use root.
 *
 * Variants compared, three interleaved rounds each (to measure noise):
 *   full         FOR select FULL (today)
 *   tenant       in.tenant / out.tenant = caller's tenant
 *   grant-aware  tenant AND the container-grant check node RLS applies;
 *                also the "deliberately expensive predicate" sanity check:
 *                if it does not slow the neighbour queries by more than twice
 *                the noise, the permission is not being exercised and the
 *                numbers mean nothing.
 *
 * Numbers are relative (local container, one machine); they say nothing about
 * absolute Cloud latency. p99 is not reported: with ~200 samples it is the max.
 */

import { RecordId } from 'surrealdb';
import type { Surreal } from 'surrealdb';
import type { KgDbClient } from '../../contracts.js';
import { dbFactory } from '../../db.js';
import { getNeighborhoodStats } from '../../activation.js';
import { getNeighborsWithWeightsBatch } from '../../tools/query.js';
import { connectTestDb, wipeData } from '../../test/connect.js';

const TOTAL_NODES = 15_000;
const TOTAL_EDGES = 45_000;
const BIG_SHARE = 0.9; // share of nodes and edges held by the big tenant
const HUBS = 30;
const HUB_EDGE_SHARE = 0.15; // ~200 edges per hub at 45k edges
const WARMUP = 20;
const ITERATIONS = 200;
// The grant-aware variant is the "deliberately expensive predicate" sanity
// check and is orders of magnitude slower (its 2-hop query hits the 5s guard),
// so it gets fewer samples; it only has to be clearly distinguishable from FULL.
const SLOW_VARIANT_WARMUP = 3;
const SLOW_VARIANT_ITERATIONS = 20;
const ROUNDS = 3;
const SEED = 264;
const CHUNK = 2000;

// Decision rule (david, 2026-11-04, starting points): p50 up at most 20%,
// p95 up at most 30%, or twice the observed noise if that is larger.
const P50_LIMIT = 0.2;
const P95_LIMIT = 0.3;

const CREATE_UPDATE = `FOR create, update WHERE in.tenant = type::record('tenant', $auth.tenantId) AND out.tenant = type::record('tenant', $auth.tenantId), FOR delete NONE`;
const TENANT_PRED = `in.tenant = type::record('tenant', $auth.tenantId) AND out.tenant = type::record('tenant', $auth.tenantId)`;
const grantCheck = (f: string) =>
  `(${f}.container = NONE OR array::any($auth.principals, |$p: any| { LET $parts = string::split($p, ':'); RETURN ${f}.container.granted_principals CONTAINS type::record($parts[0], $parts[1]); }))`;

type VariantName = 'full' | 'tenant' | 'grant-aware';
const VARIANTS: Record<VariantName, string> = {
  full: 'FULL',
  tenant: `WHERE ${TENANT_PRED}`,
  'grant-aware': `WHERE ${TENANT_PRED} AND ${grantCheck('in')} AND ${grantCheck('out')}`,
};

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);
const pick = (n: number) => Math.floor(rand() * n);

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

async function insertChunks(db: Surreal, sql: string, rows: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.query(sql, { rows: rows.slice(i, i + CHUNK) });
  }
}

interface Graph {
  bigNodeIds: string[];
  hubIds: string[];
  edgePairs: { from: string; to: string }[];
  sessionId: string;
}

async function seed(root: Surreal): Promise<Graph> {
  await wipeData(root);
  const bigNodes = Math.round(TOTAL_NODES * BIG_SHARE);
  const bigEdges = Math.round(TOTAL_EDGES * BIG_SHARE);
  const tenants = [
    { id: 'tenant_big', nodes: bigNodes, edges: bigEdges },
    { id: 'tenant_mid', nodes: Math.round((TOTAL_NODES - bigNodes) * 0.7), edges: Math.round((TOTAL_EDGES - bigEdges) * 0.7) },
    { id: 'tenant_small', nodes: TOTAL_NODES - bigNodes - Math.round((TOTAL_NODES - bigNodes) * 0.7), edges: TOTAL_EDGES - bigEdges - Math.round((TOTAL_EDGES - bigEdges) * 0.7) },
  ];

  await root.query(
    tenants
      .map(
        (t) =>
          `CREATE tenant:${t.id} SET name = '${t.id}'; CREATE session:s_${t.id} SET tenant = tenant:${t.id};`
      )
      .join('\n')
  );
  // Three containers in the big tenant, all granted to its tenant principal, so
  // the grant-aware predicate does real work on the containerised half of the nodes.
  await root.query(
    [0, 1, 2]
      .map(
        (i) =>
          `CREATE container:c${i} SET name = 'c${i}', tenant = tenant:tenant_big, owner = principal:tenant_tenant_big, granted_principals = [principal:tenant_tenant_big];`
      )
      .join('\n')
  );

  let bigNodeIds: string[] = [];
  let hubIds: string[] = [];
  const edgePairs: { from: string; to: string }[] = [];

  for (const t of tenants) {
    const ids = Array.from({ length: t.nodes }, (_, i) => `${t.id}_n${i}`);
    const nodeRows = ids.map((id, i) => ({
      id: new RecordId('node', id),
      content: `node ${id}`,
      source: 'bench',
      type: 'observation',
      tenant: new RecordId('tenant', t.id),
      // Half of the big tenant's nodes sit in a granted container.
      ...(t.id === 'tenant_big' && i % 2 === 0 ? { container: new RecordId('container', `c${i % 3}`) } : {}),
      session_created: new RecordId('session', `s_${t.id}`),
      session_activated: new RecordId('session', `s_${t.id}`),
    }));
    await insertChunks(root, 'INSERT INTO node $rows RETURN NONE', nodeRows);

    const hubs = ids.slice(0, Math.min(HUBS, ids.length));
    const rows: Record<string, unknown>[] = [];
    for (let e = 0; e < t.edges; e++) {
      let from = ids[pick(ids.length)]!;
      let to = ids[pick(ids.length)]!;
      if (rand() < HUB_EDGE_SHARE) from = hubs[pick(hubs.length)]!;
      if (from === to) to = ids[(ids.indexOf(to) + 1) % ids.length]!;
      rows.push({
        in: new RecordId('node', from),
        out: new RecordId('node', to),
        weight: 0.1 + rand() * 0.9,
        type: 'explicit',
        session_reinforced: new RecordId('session', `s_${t.id}`),
      });
      if (t.id === 'tenant_big') edgePairs.push({ from, to });
    }
    await insertChunks(root, 'INSERT RELATION INTO edge $rows RETURN NONE', rows);

    if (t.id === 'tenant_big') {
      bigNodeIds = ids;
      hubIds = hubs;
    }
  }
  return { bigNodeIds, hubIds, edgePairs, sessionId: 's_tenant_big' };
}

interface Workload {
  name: string;
  run: (db: KgDbClient, i: number) => Promise<void>;
}

function workloads(g: Graph): Workload[] {
  const nonHub = g.bigNodeIds.slice(HUBS);
  return [
    {
      // The spread-activation hop: up to 50 active ids, outbound + inbound.
      name: 'neighbors_batch_50 (query.ts getNeighborsWithWeightsBatch)',
      run: async (db, i) => {
        const ids = Array.from({ length: 45 }, (_, k) => nonHub[(i * 45 + k * 7) % nonHub.length]!).concat(
          g.hubIds.slice(i % 25, (i % 25) + 5)
        );
        await getNeighborsWithWeightsBatch(db, ids.map((id) => `node:${id}`));
      },
    },
    {
      name: 'neighbors_hub (one ~200-degree hub)',
      run: async (db, i) => {
        await getNeighborsWithWeightsBatch(db, [`node:${g.hubIds[i % g.hubIds.length]}`]);
      },
    },
    {
      // activation.ts 2-hop neighbourhood stats. It swallows timeouts and returns
      // defaults, so a run that hits the 5s guard shows up as ~5000ms here.
      name: 'neighborhood_2hop (activation.ts getNeighborhoodStats)',
      run: async (db, i) => {
        await getNeighborhoodStats(db, nonHub[(i * 13) % nonHub.length]!);
      },
    },
    {
      // relate.ts: existing-edge lookup before reinforce (indexed on in).
      name: 'relate_existing_lookup (relate.ts edge by in+out)',
      run: async (db, i) => {
        const p = g.edgePairs[(i * 31) % g.edgePairs.length]!;
        await db.queryOne(
          `SELECT * FROM edge WHERE in = type::record('node', $from_id) AND out = type::record('node', $to_id) LIMIT 1`,
          { from_id: p.from, to_id: p.to }
        );
      },
    },
    {
      // relate.ts: per-session rate-limit count. session_reinforced is indexed,
      // but every candidate row still goes through the select permission.
      name: 'relate_session_count (relate.ts count by session)',
      run: async (db) => {
        await db.queryOne(
          `SELECT count() AS count FROM edge WHERE session_reinforced = type::record('session', $session_id) GROUP ALL`,
          { session_id: g.sessionId }
        );
      },
    },
  ];
}

interface Stats {
  p50: number;
  p95: number;
}

async function measure(db: KgDbClient, w: Workload, warmup: number, iterations: number): Promise<Stats> {
  for (let i = 0; i < warmup; i++) await w.run(db, i);
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await w.run(db, warmup + i);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { p50: percentile(times, 50), p95: percentile(times, 95) };
}

async function applyVariant(root: Surreal, v: VariantName): Promise<void> {
  await root.query(
    `DEFINE TABLE OVERWRITE edge TYPE RELATION IN node OUT node SCHEMAFULL PERMISSIONS FOR select ${VARIANTS[v]}, ${CREATE_UPDATE};`
  );
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const fmt = (n: number) => n.toFixed(2);

async function main(): Promise<void> {
  const root = await connectTestDb();
  if (!root) throw new Error('database not reachable (see KG_DB_URL)');
  try {
    console.log(`Seeding ~${TOTAL_NODES} nodes / ~${TOTAL_EDGES} edges ...`);
    const graph = await seed(root);
    const ws = workloads(graph);

    // A fresh record-user session per variant: the kg_server token lasts 1h and
    // a full run (with the slow variant) can outlive one.
    const newSession = () =>
      dbFactory.createScoped({
        sub: 'bench_user',
        tenantId: 'tenant_big',
        scope: 'kg:read kg:write',
        principals: ['principal:user_bench_user', 'principal:tenant_tenant_big'],
        projects: [],
        tier: 'free',
      });

    // Rows the caller can see per variant: proves the permission is in effect.
    const visible = {} as Record<VariantName, number>;
    // results[workload][variant] = per-round stats
    const results = new Map<string, Map<VariantName, Stats[]>>();
    for (const w of ws) results.set(w.name, new Map());

    try {
      for (let round = 1; round <= ROUNDS; round++) {
        for (const v of Object.keys(VARIANTS) as VariantName[]) {
          await applyVariant(root, v);
          const db = await newSession();
          try {
            if (round === 1) {
              const c = await db.queryOne<{ count: number }>('SELECT count() AS count FROM edge GROUP ALL');
              visible[v] = c?.count ?? 0;
            }
            const slow = v === 'grant-aware';
            for (const w of ws) {
              const s = await measure(db, w, slow ? SLOW_VARIANT_WARMUP : WARMUP, slow ? SLOW_VARIANT_ITERATIONS : ITERATIONS);
              const byVariant = results.get(w.name)!;
              byVariant.set(v, [...(byVariant.get(v) ?? []), s]);
              console.log(`round ${round} ${v.padEnd(11)} ${w.name}: p50=${fmt(s.p50)}ms p95=${fmt(s.p95)}ms`);
            }
          } finally {
            await db.close();
          }
        }
      }
    } finally {
      await applyVariant(root, 'full');
    }

    console.log('\nVisible edges to tenant_big per variant:', JSON.stringify(visible));
    console.log(`\n=== Summary (median of ${ROUNDS} rounds; noise = spread of the FULL p50 across rounds) ===`);
    for (const w of ws) {
      const byVariant = results.get(w.name)!;
      const full = byVariant.get('full')!;
      const fullP50 = median(full.map((s) => s.p50));
      const fullP95 = median(full.map((s) => s.p95));
      const noise = (Math.max(...full.map((s) => s.p50)) - Math.min(...full.map((s) => s.p50))) / fullP50;
      console.log(`\n${w.name}\n  full: p50=${fmt(fullP50)}ms p95=${fmt(fullP95)}ms noise=${(noise * 100).toFixed(1)}%`);
      for (const v of ['tenant', 'grant-aware'] as VariantName[]) {
        const s = byVariant.get(v)!;
        const p50 = median(s.map((x) => x.p50));
        const p95 = median(s.map((x) => x.p95));
        const d50 = p50 / fullP50 - 1;
        const d95 = p95 / fullP95 - 1;
        const ok = d50 <= Math.max(P50_LIMIT, 2 * noise) && d95 <= Math.max(P95_LIMIT, 2 * noise);
        console.log(
          `  ${v.padEnd(11)} p50=${fmt(p50)}ms (${(d50 * 100).toFixed(1)}%) p95=${fmt(p95)}ms (${(d95 * 100).toFixed(1)}%) -> ${ok ? 'WITHIN' : 'EXCEEDS'} limit` +
            (v === 'grant-aware' ? `  sanity: ${d50 > 2 * noise ? 'permission exercised' : 'NOT distinguishable from noise'}` : '')
        );
      }
    }
  } finally {
    await wipeData(root);
    await root.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
