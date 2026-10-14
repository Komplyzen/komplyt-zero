import type {
  ToolHandler,
  MetaModelParams,
  MetaModelResponse,
  KgDbClient,
  EmbeddingProvider,
  ToolContext,
  ToolResult,
} from '../contracts.js';
import {
  metaModelParamsSchema,
  metaModelResponseSchema,
  methodologyMetaModelSchema,
  resiliencyMetaModelSchema,
  processMetaModelSchema,
  META_MODEL_LICENSED_TIERS,
  META_MODEL_METHODOLOGY_TIERS,
  toolSuccess,
  toolError,
  extractRecordId,
} from '../contracts.js';
import { isLocalAuthMode } from '../auth-local.js';
import { childLogger } from '../logger.js';
import { findDefaultContainer } from './default-container.js';

const logger = childLogger('meta-model');

/**
 * kg_meta_model reads. The models are not computed here: a batch job computes the methodology,
 * resiliency and process lenses ahead of time and stores one row per container, scope, scope id
 * and lens in meta_model (migration 037). Self-hosters fill that table with their own pipeline,
 * or use the hosted service. Row-level security decides which rows a caller can see.
 */

const NOT_COMPUTED = 'No model computed yet for this scope.';

interface StoredMetaModel {
  status: 'confident' | 'provisional' | 'insufficient';
  explanation: string;
  model?: object | null;
  computed_at: unknown;
  job_version?: string;
}

function errorResponse(
  code: 'container_not_found' | 'access_denied' | 'invalid_scope' | 'internal_error' | 'tier_required',
  message: string
): ToolResult {
  const response: MetaModelResponse = {
    status: 'error',
    explanation: message,
    error_code: code,
  };
  return toolSuccess(response);
}

/** Live containers only: a soft-deleted container serves no model while it awaits purge. */
async function resolveContainerId(
  db: KgDbClient,
  ctx: ToolContext,
  explicitId?: string
): Promise<{ id: string; error?: string }> {
  if (explicitId) {
    const cid = extractRecordId(explicitId, 'container');
    const exists = await db.queryOne<{ id: string }>(
      `SELECT id FROM container WHERE id = type::record('container', $cid) AND deleted_at = NONE LIMIT 1`,
      { cid }
    );
    if (!exists) {
      return { id: '', error: 'container_not_found' };
    }
    return { id: cid };
  }

  const defaultId = await findDefaultContainer(db, ctx.tenantId);
  return defaultId ? { id: defaultId } : { id: '', error: 'container_not_found' };
}

const MODEL_SCHEMAS = {
  methodology: methodologyMetaModelSchema,
  resiliency: resiliencyMetaModelSchema,
  process: processMetaModelSchema,
} as const;

/** ISO 8601 with milliseconds, whatever form the driver hands back. */
function isoTime(value: unknown): string | undefined {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// Plan gating on the hosted service (not applied in local auth mode: a self-hoster has everything).
// The stored meta-models are part of the paid plans, and the batch job computes only for them
// (META_MODEL_LICENSED_TIERS); the methodology lens is further limited to the business plans.
const includes = (tiers: readonly string[], tier: string) => tiers.includes(tier);

export const metaModelTool: ToolHandler<MetaModelParams> = {
  name: 'kg_meta_model',
  description:
    'Read the stored meta-model of a container, project or person: methodology patterns, resiliency metrics, or process flows depending on lens. ' +
    'Models are computed ahead of time (nightly on the hosted service), not on request; a scope with no stored model yet returns status "not_computed" ' +
    'and "computed_at" says how fresh a model is.',
  inputSchema: metaModelParamsSchema,
  responseSchema: metaModelResponseSchema,
  requiredScope: 'kg:read',
  annotations: {
    title: 'Read Meta-Model',
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },

  async execute(
    db: KgDbClient,
    _embed: EmbeddingProvider,
    ctx: ToolContext,
    params: MetaModelParams
  ): Promise<ToolResult> {
    const lens = params.lens ?? 'methodology';

    // Plan gates (hosted only), checked before any read.
    if (!isLocalAuthMode()) {
      const tier = ctx.claims.tier;
      if (!includes(META_MODEL_LICENSED_TIERS, tier)) {
        return toolError(
          'SCOPE_DENIED',
          `The meta-model (methodology, resiliency and process lenses) is part of the paid plans (Team, Pro, Enterprise). ` +
          `Your current plan: ${tier}. Upgrade at kompl.yt/pricing.`
        );
      }
      if (lens === 'methodology' && !includes(META_MODEL_METHODOLOGY_TIERS, tier)) {
        return toolError(
          'SCOPE_DENIED',
          `The methodology lens covers decision heuristics, quality gates, and structural patterns — available on business plans (Team, Enterprise). ` +
          `Your current plan: ${tier}. Upgrade at kompl.yt/pricing to unlock the methodology lens. ` +
          `The 'process' and 'resiliency' lenses are included in every paid plan.`
        );
      }
    }

    try {
      const containerResult = await resolveContainerId(db, ctx, params.scope === 'container' ? params.id : undefined);
      if (containerResult.error) {
        return errorResponse('container_not_found', `Container not found${params.id ? `: ${params.id}` : ''}`);
      }
      const containerId = containerResult.id;

      // Validate project scope
      if (params.scope === 'project' && params.id) {
        const project = await db.queryOne<{ id: string }>(
          `SELECT id FROM project WHERE name = $name AND tenant = type::record('tenant', $tenant_id) LIMIT 1`,
          { name: params.id, tenant_id: ctx.tenantId }
        );
        if (!project) {
          return errorResponse('invalid_scope', `Project not found: ${params.id}`);
        }
      }

      const stored = await db.queryOne<StoredMetaModel>(
        `SELECT status, explanation, model, computed_at, job_version FROM meta_model
         WHERE container = type::record('container', $cid)
           AND scope = $scope AND scope_id = $scope_id AND lens = $lens
         LIMIT 1`,
        {
          cid: containerId,
          scope: params.scope,
          // '' for the container scope: a unique index cannot hold NONE
          scope_id: params.scope === 'container' ? '' : (params.id ?? ''),
          lens,
        }
      );

      if (!stored) {
        const response: MetaModelResponse = { status: 'not_computed', explanation: NOT_COMPUTED, meta_model: null };
        return toolSuccess(response);
      }

      const computed_at = isoTime(stored.computed_at);
      if (stored.status === 'insufficient' || !stored.model) {
        const response: MetaModelResponse = {
          status: 'insufficient',
          explanation: stored.explanation,
          meta_model: null,
          computed_at,
        };
        return toolSuccess(response);
      }

      // Served as written, but only if it has the documented shape for its lens: the writer is a batch
      // job or a self-hoster's own pipeline, and clients validate against the published schemas.
      const parsed = MODEL_SCHEMAS[lens].safeParse(stored.model);
      if (!parsed.success) {
        logger.error(
          { lens, scope: params.scope, jobVersion: stored.job_version, issues: parsed.error.issues.slice(0, 5) },
          'Stored meta-model does not match the documented shape'
        );
        return errorResponse('internal_error', 'The stored meta-model does not match the documented shape');
      }
      const response = {
        status: stored.status,
        explanation: stored.explanation,
        meta_model: stored.model,
        computed_at,
      } as MetaModelResponse;
      return toolSuccess(response);
    } catch (err) {
      logger.error({ err }, 'Reading the meta-model failed');
      return errorResponse('internal_error', 'Failed to read meta-model');
    }
  },
};
