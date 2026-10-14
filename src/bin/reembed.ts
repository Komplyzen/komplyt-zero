#!/usr/bin/env bun
/**
 * Re-embed every node whose vector is missing, has the wrong dimension, or was
 * produced by a different model than the configured provider. Run this after
 * switching EMBEDDING_PROVIDER/EMBEDDING_MODEL: vectors from different models
 * are not comparable.
 *
 * Usage:
 *   bun run bin/reembed.ts --dry-run          # Preview work
 *   bun run bin/reembed.ts --limit 10         # Test on 10 nodes (positive integer)
 *   bun run bin/reembed.ts                    # Full re-embed
 *   bun run bin/reembed.ts --allow-fixture    # Permit the fixture provider (test databases only)
 *
 * Env vars (from .env or environment):
 *   KG_DB_URL, KG_DB_USER, KG_DB_PASS, KG_DB_NS, KG_DB_NAME
 *   EMBEDDING_PROVIDER (default cohere) and its settings: EMBEDDING_API_KEY
 *   (COHERE_API_KEY accepted for cohere), EMBEDDING_BASE_URL, EMBEDDING_MODEL
 *   (OLLAMA_URL / OLLAMA_MODEL accepted for ollama)
 */

import { Surreal } from 'surrealdb';
import { createProviderFromEnv } from '../embed.js';
import { embeddingEnvSchema } from '../env-embedding.js';
import { formatEnvIssues } from '../env-helpers.js';
import { EMBEDDING_DIMENSIONS } from '../contracts.js';
import { buildWorkList, parseLimitArg } from './reembed-work-list.js';

/**
 * Nodes embedded and written per round: bounds what one failure loses and
 * paces progress output. The provider splits each round into API batches.
 */
const ROUND_SIZE = 500;

/** The provider answered a round with the wrong number of vectors. */
class EmbeddingCountMismatch extends Error {
  override name = 'EmbeddingCountMismatch';
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  let limit: number | undefined;
  try {
    limit = parseLimitArg(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const allowFixture = args.includes('--allow-fixture');

  // Load env
  const dbUrl = process.env.KG_DB_URL;
  const dbUser = process.env.KG_DB_USER;
  const dbPass = process.env.KG_DB_PASS;
  const dbToken = process.env.KG_DB_TOKEN;
  const dbNs = process.env.KG_DB_NS || 'kg';
  const dbName = process.env.KG_DB_NAME || 'main';
  const embeddingEnv = embeddingEnvSchema.safeParse(process.env);

  if (!dbUrl) {
    console.error('Missing KG_DB_URL');
    process.exit(1);
  }
  if (!dbToken && (!dbUser || !dbPass)) {
    console.error('Missing KG_DB_TOKEN or KG_DB_USER/KG_DB_PASS');
    process.exit(1);
  }
  if (!embeddingEnv.success) {
    console.error(`Invalid embedding configuration:\n${formatEnvIssues(embeddingEnv.error)}`);
    process.exit(1);
  }
  const providerName = embeddingEnv.data.EMBEDDING_PROVIDER;
  if (providerName === 'fixture' && !allowFixture) {
    // Fixture vectors are hashes, not semantics: written to a real database they
    // silently replace every meaningful embedding.
    console.error(
      'Refusing to re-embed with the fixture provider (EMBEDDING_PROVIDER=fixture or KG_EMBED_FIXTURES=true): ' +
      'it would overwrite real embeddings with test hashes. Pass --allow-fixture for a test database.'
    );
    process.exit(1);
  }

  // Built (and dimension-checked) up front: its model identifier selects the work list.
  const embed = await createProviderFromEnv(embeddingEnv.data);
  console.log(`Embedding provider: ${providerName} (${embed.model})`);

  // Connect to SurrealDB
  const db = new Surreal();
  const httpUrl = dbUrl.replace('wss://', 'https://').replace('ws://', 'http://');
  await db.connect(httpUrl);
  if (dbToken) {
    await db.authenticate(dbToken);
  } else {
    await db.signin({ username: dbUser!, password: dbPass! });
  }
  await db.use({ namespace: dbNs, database: dbName });

  console.log(`Connected to ${dbUrl} (${dbNs}/${dbName})`);

  const workList = await buildWorkList(db, embed.model, EMBEDDING_DIMENSIONS, limit);
  console.log(`Found ${workList.length} nodes to re-embed (target: ${EMBEDDING_DIMENSIONS} dims)`);

  if (workList.length === 0) {
    console.log('Nothing to do.');
    await db.close();
    return;
  }

  // Estimate tokens
  const totalChars = workList.reduce((sum, n) => sum + (n.content?.length || 0), 0);
  const estTokens = Math.ceil(totalChars / 3.5);
  console.log(`Estimated tokens: ~${estTokens.toLocaleString()}`);

  if (dryRun) {
    console.log('Dry run - no changes made.');
    await db.close();
    return;
  }

  console.log(
    `About to write: provider ${providerName}, model ${embed.model}, ${workList.length} nodes selected.`
  );

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < workList.length; i += ROUND_SIZE) {
    const batch = workList.slice(i, i + ROUND_SIZE);
    const texts = batch.map(n => n.content || '');

    try {
      const embeddings = await embed.embedDocuments(texts);

      // One vector per node, in order, or nothing is written: a short answer
      // would pair vectors with the wrong nodes. A provider breaking that
      // contract will break it again, so the whole run stops here.
      if (embeddings.length !== batch.length) {
        throw new EmbeddingCountMismatch(
          `Round ${Math.floor(i / ROUND_SIZE) + 1}: provider returned ${embeddings.length} embeddings ` +
          `for ${batch.length} texts; aborting before writing it (processed so far: ${processed})`
        );
      }

      // Verify dimensions
      for (const emb of embeddings) {
        if (emb.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(`Bad embedding dimension: ${emb.length} (expected ${EMBEDDING_DIMENSIONS})`);
        }
      }

      // Update nodes
      for (let j = 0; j < batch.length; j++) {
        const node = batch[j];
        const embedding = embeddings[j];

        await db.query(
          `UPDATE type::record('node', $id) SET embedding = $embedding, embedding_model = $model`,
          { id: String(node.id).replace('node:', ''), embedding, model: embed.model }
        );
      }

      processed += batch.length;
      console.log(`Processed ${processed}/${workList.length} (round ${Math.floor(i / ROUND_SIZE) + 1})`);

      // Brief pause between rounds: stay well inside provider rate limits
      if (i + ROUND_SIZE < workList.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    } catch (err) {
      if (err instanceof EmbeddingCountMismatch) throw err;
      console.error(`Round ${Math.floor(i / ROUND_SIZE) + 1} failed:`, err);
      failed += batch.length;
    }
  }

  console.log(`\nDone. Processed: ${processed}, Failed: ${failed}`);

  // Null out any remaining wrong-dimension embeddings
  const [nulled] = await db.query<[{ count: number }[]]>(
    `UPDATE node SET embedding = NONE WHERE embedding != NONE AND array::len(embedding) != $dim RETURN { count: count() }`,
    { dim: EMBEDDING_DIMENSIONS }
  );
  if (nulled?.[0]?.count > 0) {
    console.log(`Nulled ${nulled[0].count} nodes with wrong-dimension embeddings`);
  }

  // Verify
  const [stats] = await db.query<[{ total: number; embedded: number; correct_dim: number }]>(
    `RETURN {
      total: (SELECT count() FROM node GROUP ALL)[0].count,
      embedded: (SELECT count() FROM node WHERE embedding != NONE GROUP ALL)[0].count,
      correct_dim: (SELECT count() FROM node WHERE embedding != NONE AND array::len(embedding) = $dim GROUP ALL)[0].count
    }`,
    { dim: EMBEDDING_DIMENSIONS }
  );
  console.log('\nVerification:', stats);

  await db.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
