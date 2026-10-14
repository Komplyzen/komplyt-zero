/**
 * Embedding provider registry: what each provider needs and produces, as plain
 * data. Env validation (env-embedding.ts) and provider construction (embed.ts)
 * both read it; it has no I/O and no imports beyond contracts, so validating
 * the env never loads an adapter or the logger.
 *
 * Adding a provider: one entry here, plus its adapter factory in embed.ts
 * (ADAPTER_FACTORIES; the compiler refuses a provider without one).
 */
import { EMBEDDING_DIMENSIONS } from './contracts.js';

/** Generic settings every provider reads; each maps to one env variable. */
export const EMBEDDING_SETTING_ENV = {
  apiKey: 'EMBEDDING_API_KEY',
  baseUrl: 'EMBEDDING_BASE_URL',
  model: 'EMBEDDING_MODEL',
} as const;

export type EmbeddingSetting = keyof typeof EMBEDDING_SETTING_ENV;

export interface EmbeddingProviderMeta {
  /**
   * Settings this provider reads. Anything else is ignored, unvalidated: a
   * stale OLLAMA_URL left in a cohere deployment must not stop it booting.
   */
  readonly reads: readonly EmbeddingSetting[];
  /** Settings env validation insists on for this provider (a subset of `reads`) */
  readonly requires: readonly Exclude<EmbeddingSetting, 'model'>[];
  /** Model name sent to the provider when EMBEDDING_MODEL is unset */
  readonly defaultModel: string;
  /**
   * Output length fixed by the model, or 'probe' when only an embedding call
   * can tell. A fixed length means a fixed model: EMBEDDING_MODEL cannot change it.
   */
  readonly dimensions: number | 'probe';
  /** Most texts per provider request (native batch) or in flight at once (one-text APIs) */
  readonly maxBatch: number;
  /** Legacy provider-specific env names, read only when the generic one is unset */
  readonly aliases?: Partial<Record<EmbeddingSetting, string>>;
}

export const EMBEDDING_PROVIDER_META = {
  cohere: {
    // baseUrl: optional, defaults to https://api.cohere.com/v1 (requests go to <baseUrl>/embed)
    reads: ['apiKey', 'baseUrl', 'model'],
    requires: ['apiKey'],
    defaultModel: 'embed-multilingual-v3.0',
    dimensions: EMBEDDING_DIMENSIONS,
    maxBatch: 96, // Cohere /v1/embed accepts at most 96 texts per request
    aliases: { apiKey: 'COHERE_API_KEY' },
  },
  ollama: {
    reads: ['baseUrl', 'model'],
    requires: ['baseUrl'],
    // bge-m3: multilingual, 1024 dimensions, so it fits the index without a migration.
    defaultModel: 'bge-m3',
    dimensions: 'probe',
    maxBatch: 3, // /api/embeddings takes one text; keep a local server's queue short
    aliases: { baseUrl: 'OLLAMA_URL', model: 'OLLAMA_MODEL' },
  },
  fixture: {
    reads: [],
    requires: [],
    defaultModel: 'fixture',
    dimensions: EMBEDDING_DIMENSIONS,
    maxBatch: 1000,
  },
} as const satisfies Record<string, EmbeddingProviderMeta>;

export type EmbeddingProviderName = keyof typeof EMBEDDING_PROVIDER_META;

export const EMBEDDING_PROVIDER_NAMES = Object.keys(EMBEDDING_PROVIDER_META) as [
  EmbeddingProviderName,
  ...EmbeddingProviderName[],
];

/** Look up a provider by a name that may come from outside the type system. */
export function getProviderMeta(name: string): EmbeddingProviderMeta {
  if (!Object.hasOwn(EMBEDDING_PROVIDER_META, name)) {
    throw new Error(
      `Unknown embedding provider: ${name}. Supported: ${EMBEDDING_PROVIDER_NAMES.join(', ')}`
    );
  }
  return EMBEDDING_PROVIDER_META[name as EmbeddingProviderName];
}
