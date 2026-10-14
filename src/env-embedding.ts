/**
 * Embedding-provider environment variables: the Zod fragment env-schema.ts
 * composes into the server schema, also usable on its own by entrypoints that
 * do not load the full server env (bin/reembed.ts, benchmarks/runner.ts).
 * Validation is driven by the registry metadata (embed-registry.ts), so a new
 * provider needs no change here.
 */
import { z } from 'zod';
import {
  EMBEDDING_PROVIDER_NAMES,
  EMBEDDING_PROVIDER_META,
  EMBEDDING_SETTING_ENV,
  type EmbeddingProviderMeta,
  type EmbeddingSetting,
} from './embed-registry.js';
import { blankToUndefined, lowerOrUndefined, envFlag } from './env-helpers.js';

const optionalString = z.preprocess(blankToUndefined, z.string().optional());

// URLs are plain strings here and checked in checkEmbeddingEnv, only when the
// selected provider reads them: a stale OLLAMA_URL in a cohere deployment is
// ignored, not a boot failure.
export const embeddingEnvShape = {
  // One provider per install: every stored vector must come from the same model.
  // Unset means cohere (resolved below, so an explicit value can be told apart).
  EMBEDDING_PROVIDER: z.preprocess(lowerOrUndefined, z.enum(EMBEDDING_PROVIDER_NAMES).optional()),
  EMBEDDING_API_KEY: optionalString,
  EMBEDDING_BASE_URL: optionalString,
  EMBEDDING_MODEL: optionalString,
  // Legacy provider-specific names (registry `aliases`); the generic name wins.
  COHERE_API_KEY: optionalString,
  OLLAMA_URL: optionalString,
  OLLAMA_MODEL: optionalString,
  // Legacy alias for EMBEDDING_PROVIDER=fixture.
  KG_EMBED_FIXTURES: envFlag(false),
};

type RawEmbeddingEnv = z.infer<z.ZodObject<typeof embeddingEnvShape>>;
type ProviderName = (typeof EMBEDDING_PROVIDER_NAMES)[number];

const DEFAULT_PROVIDER: ProviderName = 'cohere';

/** The provider in effect, after the KG_EMBED_FIXTURES alias. */
function effectiveProvider(e: RawEmbeddingEnv): ProviderName {
  return e.KG_EMBED_FIXTURES ? 'fixture' : (e.EMBEDDING_PROVIDER ?? DEFAULT_PROVIDER);
}

/**
 * Where a setting comes from for this provider: the generic variable, else the
 * provider's legacy alias. Undefined when the provider does not read the setting.
 */
function lookup(
  e: RawEmbeddingEnv,
  meta: EmbeddingProviderMeta,
  key: EmbeddingSetting
): { envName: string; value: string } | undefined {
  if (!meta.reads.includes(key)) return undefined;
  const vars = e as Record<string, unknown>;
  const alias = meta.aliases?.[key];
  for (const envName of alias ? [EMBEDDING_SETTING_ENV[key], alias] : [EMBEDDING_SETTING_ENV[key]]) {
    const value = vars[envName];
    if (typeof value === 'string') return { envName, value };
  }
  return undefined;
}

function setting(e: RawEmbeddingEnv, meta: EmbeddingProviderMeta, key: EmbeddingSetting): string | undefined {
  return lookup(e, meta, key)?.value;
}

/** Cross-field rules: no contradictory switches, and the chosen provider has what it needs. */
export function checkEmbeddingEnv(e: RawEmbeddingEnv, ctx: z.RefinementCtx): void {
  if (e.KG_EMBED_FIXTURES && e.EMBEDDING_PROVIDER && e.EMBEDDING_PROVIDER !== 'fixture') {
    ctx.addIssue({
      code: 'custom',
      path: ['KG_EMBED_FIXTURES'],
      message: `KG_EMBED_FIXTURES=true conflicts with EMBEDDING_PROVIDER=${e.EMBEDDING_PROVIDER}; ` +
        'unset one (KG_EMBED_FIXTURES is a legacy alias for EMBEDDING_PROVIDER=fixture)',
    });
    return;
  }

  const provider = effectiveProvider(e);
  const meta: EmbeddingProviderMeta = EMBEDDING_PROVIDER_META[provider];
  for (const key of meta.requires) {
    if (setting(e, meta, key)) continue;
    const alias = meta.aliases?.[key];
    ctx.addIssue({
      code: 'custom',
      path: [EMBEDDING_SETTING_ENV[key]],
      message: `required for EMBEDDING_PROVIDER=${provider}` + (alias ? ` (${alias} is accepted as a fallback)` : ''),
    });
  }

  const baseUrl = lookup(e, meta, 'baseUrl');
  if (baseUrl && !z.string().url().safeParse(baseUrl.value).success) {
    ctx.addIssue({
      code: 'custom',
      path: [baseUrl.envName],
      message: `not a valid URL (read by EMBEDDING_PROVIDER=${provider}): ${baseUrl.value}`,
    });
  }

  const model = setting(e, meta, 'model');
  if (model && meta.dimensions !== 'probe' && model !== meta.defaultModel) {
    ctx.addIssue({
      code: 'custom',
      path: [EMBEDDING_SETTING_ENV.model],
      message: `EMBEDDING_PROVIDER=${provider} has a fixed model (${meta.defaultModel}); got ${model}`,
    });
  }
}

/**
 * Resolve aliases, fallbacks and defaults so consumers read one answer:
 * EMBEDDING_PROVIDER, EMBEDDING_API_KEY, EMBEDDING_BASE_URL and EMBEDDING_MODEL
 * are the values in effect for the chosen provider (undefined, or the registry
 * default model, for settings it does not read).
 */
export function resolveEmbeddingEnv<T extends RawEmbeddingEnv>(e: T) {
  const provider = effectiveProvider(e);
  const meta: EmbeddingProviderMeta = EMBEDDING_PROVIDER_META[provider];
  return {
    ...e,
    EMBEDDING_PROVIDER: provider,
    EMBEDDING_API_KEY: setting(e, meta, 'apiKey'),
    EMBEDDING_BASE_URL: setting(e, meta, 'baseUrl')?.replace(/\/+$/, ''),
    EMBEDDING_MODEL: setting(e, meta, 'model') ?? meta.defaultModel,
  };
}

/** Standalone schema for entrypoints that only need the embedding settings. */
export const embeddingEnvSchema = z
  .object(embeddingEnvShape)
  .superRefine(checkEmbeddingEnv)
  .transform(resolveEmbeddingEnv);

export type EmbeddingEnv = z.infer<typeof embeddingEnvSchema>;
