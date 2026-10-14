import { createHash } from 'node:crypto';
import { EmbeddingProvider, EMBEDDING_DIMENSIONS } from './contracts.js';
import {
  EMBEDDING_PROVIDER_META,
  getProviderMeta,
  type EmbeddingProviderName,
} from './embed-registry.js';
import type { EmbeddingEnv } from './env-embedding.js';
import { childLogger } from './logger.js';

const logger = childLogger('embed');

/**
 * Low-level embedding adapter interface.
 * Adapters handle API calls and auth. Business logic (batching) lives in the wrapper.
 */
export interface EmbeddingAdapter {
  readonly name: string;
  /** Identifier recorded in node.embedding_model */
  readonly model: string;
  readonly dimensions: number;

  // Embed a single text - the atomic operation every adapter must support
  embedOne(text: string, type: 'document' | 'query'): Promise<number[]>;

  // Optional: native batch support (more efficient if API supports it)
  embedBatch?(texts: string[], type: 'document' | 'query'): Promise<number[][]>;
}

/**
 * A provider request that failed. `retryable` marks failures worth retrying
 * (unreachable host, timeout, 5xx); anything else will fail the same way again.
 */
export class EmbeddingRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'EmbeddingRequestError';
  }
}

/**
 * Create an EmbeddingProvider from an adapter.
 * Splits embedDocuments into chunks of at most `maxBatch` texts: one native
 * batch call per chunk, or that many parallel single-text calls.
 */
export function createProvider(
  adapter: EmbeddingAdapter,
  options: { maxBatch: number }
): EmbeddingProvider {
  const { maxBatch } = options;

  async function embedChunk(texts: string[]): Promise<number[][]> {
    if (adapter.embedBatch) return adapter.embedBatch(texts, 'document');
    return Promise.all(texts.map(text => adapter.embedOne(text, 'document')));
  }

  async function embedDocuments(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += maxBatch) {
      results.push(...await embedChunk(texts.slice(i, i + maxBatch)));
    }
    return results;
  }

  async function embedQuery(text: string): Promise<number[]> {
    return adapter.embedOne(text, 'query');
  }

  return {
    model: adapter.model,
    get dimensions() {
      return adapter.dimensions;
    },
    embedDocuments,
    embedQuery,
  };
}

// ============================================================================
// Adapters. Each takes the generic config plus injectable I/O.
// ============================================================================

/** Provider-independent settings, already validated at the env boundary. */
export interface EmbeddingConfig {
  apiKey?: string;
  baseUrl?: string;
  /** Provider's model name; the registry default when unset */
  model?: string;
}

/** Injectable I/O, so tests can fake the network and the clock. */
export interface EmbeddingDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

type AdapterConfig = EmbeddingConfig & { model: string };
type AdapterFactory = (config: AdapterConfig, deps: EmbeddingDeps) => EmbeddingAdapter;

function required(value: string | undefined, envName: string, provider: string): string {
  if (!value) throw new Error(`${envName} required for ${provider} embedding provider`);
  return value;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const COHERE_TIMEOUT_MS = 30_000;
const COHERE_BASE_URL = 'https://api.cohere.com/v1';

/**
 * Cohere adapter (embed-multilingual-v3.0, 1024 dimensions), native batching.
 * config.model is the API model name ('embed-multilingual-v3.0'); the recorded
 * identifier is 'cohere-<API model>' = 'cohere-embed-multilingual-v3.0', the
 * exact value existing nodes carry and reembed compares against.
 * config.baseUrl (EMBEDDING_BASE_URL) replaces the API base, e.g. for a proxy;
 * unset means https://api.cohere.com/v1. Requests go to <baseUrl>/embed.
 */
export function createCohereAdapter(config: AdapterConfig, deps: EmbeddingDeps = {}): EmbeddingAdapter {
  const apiKey = required(config.apiKey, 'EMBEDDING_API_KEY', 'cohere');
  const apiModel = config.model;
  const fetchFn = deps.fetch ?? fetch;
  const url = `${(config.baseUrl ?? COHERE_BASE_URL).replace(/\/+$/, '')}/embed`;

  async function callApi(
    texts: string[],
    inputType: 'search_document' | 'search_query'
  ): Promise<number[][]> {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        texts,
        model: apiModel,
        input_type: inputType,
        embedding_types: ['float'],
      }),
      signal: AbortSignal.timeout(COHERE_TIMEOUT_MS),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new EmbeddingRequestError(`Cohere API error: ${response.status} ${error}`, response.status >= 500);
    }

    const data = await response.json() as {
      embeddings: { float: number[][] };
    };

    return data.embeddings.float;
  }

  return {
    name: 'cohere',
    model: `cohere-${apiModel}`,
    dimensions: EMBEDDING_DIMENSIONS,

    async embedOne(text, type) {
      const inputType = type === 'query' ? 'search_query' : 'search_document';
      const [embedding] = await callApi([text], inputType);
      return embedding;
    },

    async embedBatch(texts, type) {
      const inputType = type === 'query' ? 'search_query' : 'search_document';
      return callApi(texts, inputType);
    },
  };
}

const OLLAMA_TIMEOUT_MS = 60_000;

/**
 * Ollama resolves an untagged model to ':latest'; record it that way so
 * `bge-m3` and `bge-m3:latest` are one model. A tag is a ':' in the last path
 * segment (a registry host may carry a port: `host:5000/ns/model`).
 */
function normalizeOllamaModel(model: string): string {
  const lastSegment = model.slice(model.lastIndexOf('/') + 1);
  return lastSegment.includes(':') ? model : `${model}:latest`;
}

/**
 * Ollama adapter for local embedding models.
 * No native batching - wrapper handles parallelization.
 * The model's dimension is unknown until it answers; boot probes it
 * (see verifyEmbeddingDimensions).
 */
export function createOllamaAdapter(config: AdapterConfig, deps: EmbeddingDeps = {}): EmbeddingAdapter {
  const baseUrl = required(config.baseUrl, 'EMBEDDING_BASE_URL', 'ollama').replace(/\/+$/, '');
  const model = normalizeOllamaModel(config.model);
  const fetchFn = deps.fetch ?? fetch;
  const url = `${baseUrl}/api/embeddings`;
  let detectedDimensions: number | null = null;

  return {
    name: 'ollama',
    model: `ollama:${model}`,
    get dimensions() {
      // Detected dimensions once a call has answered, expected until then
      return detectedDimensions ?? EMBEDDING_DIMENSIONS;
    },

    async embedOne(text) {
      let response: Response;
      try {
        response = await fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt: text }),
          signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
        });
      } catch (err) {
        // Connection refused, DNS, timeout: the server may still be starting.
        throw new EmbeddingRequestError(`Ollama request to ${url} failed: ${errorMessage(err)}`, true);
      }

      if (!response.ok) {
        const error = await response.text();
        throw new EmbeddingRequestError(`Ollama API error: ${response.status} ${error}`, response.status >= 500);
      }

      const data = await response.json() as { embedding?: unknown };
      if (!Array.isArray(data.embedding)) {
        throw new EmbeddingRequestError(
          `Ollama returned no embedding for model "${model}" (response: ${JSON.stringify(data).slice(0, 200)}); ` +
          'is it an embedding model?',
          false
        );
      }
      detectedDimensions = data.embedding.length;
      return data.embedding as number[];
    },
    // No embedBatch - wrapper will parallelize
  };
}

/**
 * Fixture adapter for tests.
 * Deterministic hash-based embeddings, no network calls.
 */
export function createFixtureAdapter(): EmbeddingAdapter {
  function hashToVector(text: string): number[] {
    const hash = createHash('sha256').update(text).digest();
    const vector: number[] = [];

    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      const byte = hash[i % 32];
      vector.push((byte / 127.5) - 1);
    }

    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    return vector.map(v => v / norm);
  }

  return {
    name: 'fixture',
    model: 'fixture',
    dimensions: EMBEDDING_DIMENSIONS,

    async embedOne(text) {
      return hashToVector(text);
    },

    // Fixture can "batch" synchronously
    async embedBatch(texts) {
      return texts.map(t => hashToVector(t));
    },
  };
}

/** Create fixture provider - convenience wrapper for tests */
export function createFixtureProvider(): EmbeddingProvider {
  return createProvider(createFixtureAdapter(), { maxBatch: EMBEDDING_PROVIDER_META.fixture.maxBatch });
}

// ============================================================================
// Construction: registry metadata (embed-registry.ts) + one adapter per provider.
// ============================================================================

const ADAPTER_FACTORIES = {
  cohere: createCohereAdapter,
  ollama: createOllamaAdapter,
  fixture: () => createFixtureAdapter(),
} as const satisfies Record<EmbeddingProviderName, AdapterFactory>;

/** Build the named provider. Does not check its dimension; see verifyEmbeddingDimensions. */
export function createEmbeddingProvider(
  name: string,
  config: EmbeddingConfig,
  deps: EmbeddingDeps = {}
): EmbeddingProvider {
  const meta = getProviderMeta(name);
  const factory: AdapterFactory = ADAPTER_FACTORIES[name as EmbeddingProviderName];
  const adapter = factory({ ...config, model: config.model ?? meta.defaultModel }, deps);
  return createProvider(adapter, { maxBatch: meta.maxBatch });
}

/**
 * Boot probe budget. Each attempt gets PROBE_ATTEMPT_TIMEOUT_MS (shorter than
 * the 60s runtime OLLAMA_TIMEOUT_MS); retryable failures wait out the delays
 * below. Worst case: 5 attempts x 10s + 1+2+3+4s backoff = 60s, then the
 * process exits. Docs (README, CLAUDE.md, .env.example) and bench/lib.sh
 * start_kg's /health wait quote this figure.
 */
const PROBE_ATTEMPT_TIMEOUT_MS = 10_000;
const PROBE_RETRY_DELAYS_MS = [1_000, 2_000, 3_000, 4_000];

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One probe embedding, bounded by PROBE_ATTEMPT_TIMEOUT_MS. A timed-out request
 * is abandoned (the adapter's own timeout still ends it) and counts as retryable:
 * a cold server may still be loading the model.
 */
async function probeOnce(provider: EmbeddingProvider): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new EmbeddingRequestError(`no answer within ${PROBE_ATTEMPT_TIMEOUT_MS / 1000}s`, true)),
      PROBE_ATTEMPT_TIMEOUT_MS
    );
  });
  try {
    return (await Promise.race([provider.embedQuery('dimension probe'), timeout])).length;
  } finally {
    clearTimeout(timer);
  }
}

/** One probe embedding, retried while the failure looks transient. */
async function probeDimensions(
  provider: EmbeddingProvider,
  name: string,
  baseUrl: string | undefined,
  sleep: (ms: number) => Promise<void>
): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await probeOnce(provider);
    } catch (err) {
      const retryable = err instanceof EmbeddingRequestError && err.retryable;
      if (retryable && attempt < PROBE_RETRY_DELAYS_MS.length) {
        logger.warn({ provider: name, baseUrl, attempt: attempt + 1, err: errorMessage(err) }, 'Embedding probe failed, retrying');
        await sleep(PROBE_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      const where = baseUrl ? `, base URL ${baseUrl}` : '';
      throw new Error(
        `Embedding provider probe failed: provider "${name}" (model "${provider.model}"${where}) ` +
        `${retryable ? `did not answer after ${attempt + 1} attempts` : 'rejected the request'}: ${errorMessage(err)}`
      );
    }
  }
}

/**
 * Refuse a provider whose vectors the index cannot hold. Statically known
 * dimensions are checked without a network call; 'probe' providers embed once
 * (retried with backoff while the server is unreachable, slow or failing with
 * 5xx; at most ~60s in all, see PROBE_ATTEMPT_TIMEOUT_MS).
 */
export async function verifyEmbeddingDimensions(
  provider: EmbeddingProvider,
  name: string,
  options: { expected?: number; baseUrl?: string; sleep?: (ms: number) => Promise<void> } = {}
): Promise<void> {
  const expected = options.expected ?? EMBEDDING_DIMENSIONS;
  const actual = getProviderMeta(name).dimensions === 'probe'
    ? await probeDimensions(provider, name, options.baseUrl, options.sleep ?? defaultSleep)
    : provider.dimensions;
  if (actual !== expected) {
    throw new Error(
      `Embedding dimension mismatch: provider "${name}" with model "${provider.model}" ` +
      `produces ${actual}-dimensional vectors, but this install requires ${expected} ` +
      `(EMBEDDING_DIMENSIONS, the vector index dimension). Configure a ${expected}-dimensional model.`
    );
  }
}

/**
 * Build and verify the provider selected by the (already validated) env.
 * Every entrypoint calls this before serving or working; a rejection means
 * the process must not start.
 */
export async function createProviderFromEnv(
  env: EmbeddingEnv,
  deps: EmbeddingDeps = {}
): Promise<EmbeddingProvider> {
  const name = env.EMBEDDING_PROVIDER;
  const config = {
    apiKey: env.EMBEDDING_API_KEY,
    baseUrl: env.EMBEDDING_BASE_URL,
    model: env.EMBEDDING_MODEL,
  };
  const provider = createEmbeddingProvider(name, config, deps);
  await verifyEmbeddingDimensions(provider, name, { baseUrl: config.baseUrl, sleep: deps.sleep });
  logger.info({ provider: name, model: provider.model }, 'Embedding provider ready');
  return provider;
}
