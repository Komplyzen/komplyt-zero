/**
 * kg_meta_model as a reader: the lenses are computed ahead of time by a private
 * batch job and stored in meta_model; the tool only reads the stored row for the caller's scope.
 *
 * Reads go through a real scoped connection (the kg_server access from the migrations), so the
 * container-grant and tenant rules of meta_model's RLS are what decides what a caller can see.
 * Only the seed rows are written here, as root, the way the job writes them.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Surreal } from 'surrealdb';
import {
  EMBEDDING_DIMENSIONS,
  principalId,
  type EmbeddingProvider,
  type KgDbClient,
  type KgTokenPayload,
  type MetaModelResponse,
  type ToolContext,
  META_MODEL_LICENSED_TIERS,
  META_MODEL_METHODOLOGY_TIERS,
} from '../contracts.js';
import { dbFactory } from '../db.js';
import { metaModelTool } from '../tools/meta-model.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectTestDb, wipeData } from './connect.js';

let rootDb: Surreal;

const embed: EmbeddingProvider = {
  embedDocuments: async (t) => t.map(() => []),
  embedQuery: async () => [],
  model: 'test-mock',
  dimensions: EMBEDDING_DIMENSIONS,
};

const claimsFor = (tenantId: string, sub: string, tier: KgTokenPayload['tier'] = 'team'): KgTokenPayload => ({
  sub,
  tenantId,
  projects: [],
  scope: 'kg:read kg:write',
  principals: [principalId('User', sub), principalId('Tenant', tenantId)],
  tier,
  platformRole: 'member',
});

const ctxFor = (claims: KgTokenPayload): ToolContext => ({
  claims,
  tenantId: claims.tenantId,
  projects: claims.projects,
  scope: claims.scope,
  currentSession: null,
});

async function ask(
  claims: KgTokenPayload,
  params: { scope: 'container' | 'project' | 'person'; id?: string; lens?: 'methodology' | 'resiliency' | 'process' }
) {
  const db: KgDbClient = await dbFactory.createScoped(claims);
  try {
    const result = await metaModelTool.execute(db, embed, ctxFor(claims), { lens: 'methodology', ...params });
    // A refusal (plan gate) is plain text; everything else is a JSON response.
    let data = undefined as unknown as MetaModelResponse & Record<string, unknown>;
    try {
      data = JSON.parse(result.content[0].text);
    } catch {
      /* not JSON */
    }
    return { result, data };
  } finally {
    await db.close();
  }
}

// Canonical valid models: what the batch job wrote for its seed graph (test/fixtures), one per lens.
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'meta-model-job-output.json'), 'utf8')) as Array<{
  lens: 'methodology' | 'resiliency' | 'process';
  status: string;
  explanation: string;
  model: Record<string, unknown>;
}>;
const modelOf = (lens: 'methodology' | 'resiliency' | 'process') => FIXTURE.find((r) => r.lens === lens)!.model;
const METHODOLOGY = modelOf('methodology');
const RESILIENCY = modelOf('resiliency');
const PROCESS = modelOf('process');

async function seedRow(opts: {
  container: string;
  tenant: string;
  scope?: string;
  scopeId?: string;
  lens?: string;
  status?: string;
  explanation?: string;
  model?: unknown;
}) {
  await rootDb.query(
    `CREATE meta_model SET
       tenant = type::record('tenant', $tenant), container = type::record('container', $container),
       scope = $scope, scope_id = $scope_id, lens = $lens, status = $status,
       explanation = $explanation, model = $model, computed_at = <datetime>'2026-10-09T03:00:00Z', job_version = 'test'`,
    {
      tenant: opts.tenant,
      container: opts.container,
      scope: opts.scope ?? 'container',
      scope_id: opts.scopeId ?? '',
      lens: opts.lens ?? 'methodology',
      status: opts.status ?? 'confident',
      explanation: opts.explanation ?? 'stored explanation',
      model: opts.model ?? METHODOLOGY,
    }
  );
}

// Several tests here seed many rows or make many reads; over the WAN to the CI database they exceeded
// the 5s default (3 timeouts in kg-ci run 38204255013). Real work, not a hang.
describe('kg_meta_model reads the stored meta-model', { timeout: 30_000 }, () => {
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
  });

  beforeEach(async () => {
    if (skipTests) return;
    await wipeData(rootDb);
    await rootDb.query('DELETE meta_model');
    await rootDb.query(`
      CREATE tenant:acme SET name = 'Acme';
      CREATE tenant:rival SET name = 'Rival';
      CREATE principal:tenant_acme SET type = 'Tenant', ref_id = 'acme';
      CREATE principal:tenant_rival SET type = 'Tenant', ref_id = 'rival';
      CREATE principal:user_alice SET type = 'User', ref_id = 'alice';
      CREATE container:acme_default SET name = 'Company Knowledge', tenant = tenant:acme,
        owner = principal:tenant_acme, granted_principals = [principal:tenant_acme];
      CREATE container:acme_private SET name = 'Private', tenant = tenant:acme,
        owner = principal:user_alice, granted_principals = [principal:user_alice];
      CREATE container:rival_default SET name = 'Company Knowledge', tenant = tenant:rival,
        owner = principal:tenant_rival, granted_principals = [principal:tenant_rival];
      CREATE project:alpha SET name = 'alpha', tenant = tenant:acme;
    `);
  });

  afterAll(async () => {
    await rootDb?.close();
  });

  it('a scope with no stored model says so plainly, and is not an error', async () => {
    const { result, data } = await ask(claimsFor('acme', 'bob'), { scope: 'container', lens: 'methodology' });
    expect(result.isError).toBeFalsy();
    expect(data.status).toBe('not_computed');
    expect(data.meta_model).toBeNull();
    expect(data.explanation).toMatch(/no model computed yet for this scope/i);
  });

  it('returns the stored row as it is: status, explanation, model and when it was computed', async () => {
    await seedRow({ container: 'acme_default', tenant: 'acme', status: 'provisional' });
    const { result, data } = await ask(claimsFor('acme', 'bob'), { scope: 'container', lens: 'methodology' });
    expect(result.isError).toBeFalsy();
    expect(data).toEqual({
      status: 'provisional',
      explanation: 'stored explanation',
      meta_model: METHODOLOGY,
      computed_at: '2026-10-09T03:00:00.000Z',
    });
  });

  it('defaults to the methodology lens', async () => {
    await seedRow({ container: 'acme_default', tenant: 'acme' });
    const { data } = await ask(claimsFor('acme', 'bob'), { scope: 'container' });
    expect(data.status).toBe('confident');
  });

  it('each lens is its own row', async () => {
    await seedRow({ container: 'acme_default', tenant: 'acme', lens: 'methodology' });
    await seedRow({ container: 'acme_default', tenant: 'acme', lens: 'resiliency', model: RESILIENCY, explanation: 'r' });
    const resiliency = await ask(claimsFor('acme', 'bob'), { scope: 'container', lens: 'resiliency' });
    expect(resiliency.data).toMatchObject({ status: 'confident', explanation: 'r', meta_model: RESILIENCY });
    const process = await ask(claimsFor('acme', 'bob'), { scope: 'container', lens: 'process' });
    expect(process.data.status).toBe('not_computed');
  });

  it('project and person scopes read their own rows', async () => {
    await seedRow({ container: 'acme_default', tenant: 'acme', scope: 'project', scopeId: 'alpha', explanation: 'project row' });
    await seedRow({ container: 'acme_default', tenant: 'acme', scope: 'person', scopeId: 'ann@acme.example', explanation: 'person row' });
    const claims = claimsFor('acme', 'bob');
    expect((await ask(claims, { scope: 'project', id: 'alpha' })).data.explanation).toBe('project row');
    expect((await ask(claims, { scope: 'person', id: 'ann@acme.example' })).data.explanation).toBe('person row');
    expect((await ask(claims, { scope: 'person', id: 'nobody@acme.example' })).data.status).toBe('not_computed');
  });

  it('an insufficient result keeps its null model and its time', async () => {
    await seedRow({
      container: 'acme_default',
      tenant: 'acme',
      status: 'insufficient',
      explanation: 'Not enough connected information yet.',
      model: undefined,
    });
    // the seed helper defaults the model; an insufficient result stores none
    await rootDb.query('UPDATE meta_model SET model = NONE');
    const { data } = await ask(claimsFor('acme', 'bob'), { scope: 'container' });
    expect(data).toMatchObject({ status: 'insufficient', meta_model: null, computed_at: '2026-10-09T03:00:00.000Z' });
  });

  it('a project that does not exist is invalid_scope, as before', async () => {
    const { data } = await ask(claimsFor('acme', 'bob'), { scope: 'project', id: 'no-such-project' });
    expect(data).toMatchObject({ status: 'error', error_code: 'invalid_scope' });
  });

  it('an explicit container the caller cannot see is container_not_found', async () => {
    const { data } = await ask(claimsFor('acme', 'bob'), { scope: 'container', id: 'rival_default' });
    expect(data).toMatchObject({ status: 'error', error_code: 'container_not_found' });
  });

  it('a tenant never gets another tenant\'s model, even from the same default container name', async () => {
    await seedRow({ container: 'rival_default', tenant: 'rival', explanation: 'rival secrets' });
    const { data } = await ask(claimsFor('acme', 'bob'), { scope: 'container' });
    expect(data.status).toBe('not_computed');
    expect(JSON.stringify(data)).not.toContain('rival secrets');
  });

  it('a private container\'s model is only for the users it is granted to', async () => {
    await seedRow({ container: 'acme_private', tenant: 'acme', explanation: 'private model' });
    const alice = await ask(claimsFor('acme', 'alice'), { scope: 'container', id: 'acme_private' });
    expect(alice.data).toMatchObject({ status: 'confident', explanation: 'private model' });
    // Container rows are visible tenant-wide (that is how containers are listed); the model row is
    // what the grant protects, so bob gets "nothing" and never the content.
    const bob = await ask(claimsFor('acme', 'bob'), { scope: 'container', id: 'acme_private' });
    expect(bob.data.status).toBe('not_computed');
    expect(JSON.stringify(bob.data)).not.toContain('private model');
  });

  describe('deleted containers', () => {
    it('a soft-deleted container serves no model: default and explicit lookups say container_not_found', async () => {
      await seedRow({ container: 'acme_default', tenant: 'acme', explanation: 'must not be served' });
      await rootDb.query(`UPDATE container:acme_default SET deleted_at = time::now()`);
      for (const params of [{ scope: 'container' as const }, { scope: 'container' as const, id: 'acme_default' }]) {
        const { data } = await ask(claimsFor('acme', 'bob'), params);
        expect(data).toMatchObject({ status: 'error', error_code: 'container_not_found' });
        expect(JSON.stringify(data)).not.toContain('must not be served');
      }
    });
  });

  describe('stored models are validated against the documented shape', () => {
    it('a malformed stored model is an error and is not passed to the client', async () => {
      await seedRow({ container: 'acme_default', tenant: 'acme', model: { organizing_concepts: 'not an array', leaked: 'x' } });
      const { data } = await ask(claimsFor('acme', 'bob'), { scope: 'container' });
      expect(data).toMatchObject({ status: 'error', error_code: 'internal_error' });
      expect(JSON.stringify(data)).not.toContain('leaked');
    });

    it('the real output of the batch job round-trips for every lens', async () => {
      // test/fixtures/meta-model-job-output.json is what the platform job wrote for its seed graph
      const fixture = FIXTURE;
      expect(fixture.map((r) => r.lens).sort()).toEqual(['methodology', 'process', 'resiliency']);
      for (const row of fixture) {
        await seedRow({ container: 'acme_default', tenant: 'acme', ...{ lens: row.lens, status: row.status, explanation: row.explanation, model: row.model } });
        const { data } = await ask(claimsFor('acme', 'bob'), { scope: 'container', lens: row.lens });
        expect(data.status).toBe(row.status);
        expect(data.meta_model).toEqual(row.model);
      }
    });
  });

  describe('plans', () => {
    const untouched = (): KgDbClient => ({
      query: async () => {
        throw new Error('database was queried');
      },
      queryOne: async () => {
        throw new Error('database was queried');
      },
      close: async () => {},
    });
    const run = (tier: KgTokenPayload['tier'], lens: 'methodology' | 'resiliency' | 'process', db: KgDbClient = untouched()) =>
      metaModelTool.execute(db, embed, ctxFor(claimsFor('acme', 'bob', tier)), { scope: 'container', lens });

    it.each(['methodology', 'resiliency', 'process'] as const)(
      'a free workspace is refused the %s lens before anything is read, and told it needs a paid plan',
      async (lens) => {
        const result = await run('free', lens);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/paid plan/i);
        expect(result.content[0].text).not.toMatch(/available on all plans/i);
      }
    );

    it('methodology is for business plans: a pro (personal) plan is refused it before anything is read', async () => {
      const result = await run('pro', 'methodology');
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/business plans/i);
    });

    it.each([
      ['pro', 'resiliency'],
      ['pro', 'process'],
      ['team', 'methodology'],
      ['team', 'process'],
      ['enterprise', 'resiliency'],
      ['enterprise', 'methodology'],
    ] as const)('a %s workspace is served the %s lens', async (tier, lens) => {
      await seedRow({
        container: 'acme_default',
        tenant: 'acme',
        lens,
        model: lens === 'methodology' ? METHODOLOGY : lens === 'resiliency' ? RESILIENCY : PROCESS,
      });
      const { data } = await ask(claimsFor('acme', 'bob', tier), { scope: 'container', lens });
      expect(data.status).toBe('confident');
    });

    it('a workspace downgraded to free stops being served rows that are still stored', async () => {
      await seedRow({ container: 'acme_default', tenant: 'acme', lens: 'process', model: PROCESS });
      const { result } = await ask(claimsFor('acme', 'bob', 'free'), { scope: 'container', lens: 'process' });
      expect(result.isError).toBe(true);
    });

    it('the tier lists are the ones the batch job defaults to (kept in contracts so they cannot drift quietly)', () => {
      expect([...META_MODEL_LICENSED_TIERS]).toEqual(['team', 'pro', 'enterprise']);
      expect([...META_MODEL_METHODOLOGY_TIERS]).toEqual(['team', 'enterprise']);
    });
  });

  it('has no daily limit: reads are cheap', async () => {
    await seedRow({ container: 'acme_default', tenant: 'acme' });
    const claims = claimsFor('acme', 'bob');
    for (let i = 0; i < 8; i++) {
      const { result, data } = await ask(claims, { scope: 'container' });
      expect(result.isError).toBeFalsy();
      expect(data.status).toBe('confident');
    }
  });
});
