/**
 * kg_meta_model in local auth mode: "tier gating stays only for hosted
 * (komplyt mode); in local mode everything is available". The local identity is a free-tier user,
 * so without this exemption a self-hoster could never read the methodology lens.
 *
 * The mode is read from the process environment when env.ts loads, so it is set in vi.hoisted.
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.KG_AUTH_MODE = 'local';
  process.env.KG_LOCAL_SUB = 'self-hoster';
  process.env.KG_LOCAL_TENANT = 'my-lab';
  delete process.env.KOMPLYT_JWKS_URL;
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider, type MetaModelResponse } from '../contracts.js';
import { dbFactory } from '../db.js';
import { localClaims } from '../auth-local.js';
import { metaModelTool } from '../tools/meta-model.js';
import { ensureDefaultContainer } from '../tools/default-container.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectTestDb, wipeData } from './connect.js';

let rootDb: Surreal;

// A model of the documented methodology shape (the batch job's real output for its seed graph).
const methodologyModel = (
  JSON.parse(readFileSync(join(__dirname, 'fixtures', 'meta-model-job-output.json'), 'utf8')) as Array<{
    lens: string;
    model: Record<string, unknown>;
  }>
).find((r) => r.lens === 'methodology')!.model;

const embed: EmbeddingProvider = {
  embedDocuments: async (t) => t.map(() => []),
  embedQuery: async () => [],
  model: 'test-mock',
  dimensions: EMBEDDING_DIMENSIONS,
};

describe('kg_meta_model in local auth mode', () => {
  let skipTests = false;

  beforeEach((ctx) => {
    if (skipTests) ctx.skip();
  });

  beforeAll(async () => {
    const conn = await connectTestDb();
    if (!conn) {
      skipTests = true;
      return;
    }
    rootDb = conn;
    await wipeData(rootDb);
    await rootDb.query('DELETE meta_model');
  });

  afterAll(async () => {
    await rootDb?.close();
  });

  it('serves the methodology lens to the free-tier local user', async () => {
    const claims = localClaims({ KG_LOCAL_SUB: 'self-hoster', KG_LOCAL_TENANT: 'my-lab' });
    expect(claims.tier).toBe('free');
    const db = await dbFactory.createScoped(claims);
    try {
      await ensureDefaultContainer(db, 'my-lab');
      await rootDb.query(
        `CREATE meta_model SET tenant = tenant:⟨my-lab⟩, container = container:⟨my-lab_default⟩,
           scope = 'container', scope_id = '', lens = 'methodology', status = 'confident',
           explanation = 'filled by my own pipeline', model = $model,
           computed_at = time::now(), job_version = 'self-hosted'`,
        { model: methodologyModel }
      );
      const result = await metaModelTool.execute(
        db,
        embed,
        { claims, tenantId: claims.tenantId, projects: [], scope: claims.scope, currentSession: null },
        { scope: 'container', lens: 'methodology' }
      );
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text) as MetaModelResponse;
      expect(data).toMatchObject({ status: 'confident', explanation: 'filled by my own pipeline' });
    } finally {
      await db.close();
    }
  });
});
