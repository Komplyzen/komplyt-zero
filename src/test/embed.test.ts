import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import {
  createFixtureProvider,
  createEmbeddingProvider,
  createProviderFromEnv,
  verifyEmbeddingDimensions,
} from '../embed.js';
import { EMBEDDING_PROVIDER_META, EMBEDDING_PROVIDER_NAMES } from '../embed-registry.js';
import { embeddingEnvSchema } from '../env-embedding.js';
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from '../contracts.js';

type FakeFetch = typeof fetch & ReturnType<typeof vi.fn>;

/** Fake HTTP endpoint: `respond` builds the answer to each call. */
function fakeFetch(respond: (init?: RequestInit) => Response | Promise<Response>): FakeFetch {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => respond(init)) as unknown as FakeFetch;
}

/** Fake Ollama HTTP endpoint answering every embedding call with a vector of `dims`. */
function fakeOllamaFetch(dims: number): FakeFetch {
  return fakeFetch(() => new Response(JSON.stringify({ embedding: Array(dims).fill(0.01) }), { status: 200 }));
}

/** Fake Cohere /embed: one 1024-dim vector per input text. */
function fakeCohereFetch(): FakeFetch {
  return fakeFetch((init) => {
    const { texts } = JSON.parse(init?.body as string) as { texts: string[] };
    const float = texts.map(() => Array(EMBEDDING_DIMENSIONS).fill(0.02));
    return new Response(JSON.stringify({ embeddings: { float } }), { status: 200 });
  });
}

const noSleep = { sleep: vi.fn(async (_ms: number) => {}) };

function requestBody(fetchFn: FakeFetch, call = 0): Record<string, unknown> {
  return JSON.parse((fetchFn.mock.calls[call] as [string, RequestInit])[1].body as string);
}

function providerReporting(dims: number): EmbeddingProvider {
  return {
    model: 'fake-model',
    dimensions: dims,
    embedDocuments: async (texts) => texts.map(() => Array(dims).fill(0)),
    embedQuery: async () => Array(dims).fill(0),
  };
}

describe('createFixtureProvider', () => {
  const provider = createFixtureProvider();

  it('should have correct dimensions', () => {
    expect(provider.dimensions).toBe(EMBEDDING_DIMENSIONS);
  });

  describe('embedDocuments', () => {
    it('should return arrays of correct dimension', async () => {
      const texts = ['hello world', 'test content'];
      const embeddings = await provider.embedDocuments(texts);

      expect(embeddings).toHaveLength(2);
      expect(embeddings[0]).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(embeddings[1]).toHaveLength(EMBEDDING_DIMENSIONS);
    });

    it('should return deterministic embeddings for same content', async () => {
      const [first] = await provider.embedDocuments(['test']);
      const [second] = await provider.embedDocuments(['test']);

      expect(first).toEqual(second);
    });

    it('should return different embeddings for different content', async () => {
      const [first] = await provider.embedDocuments(['hello']);
      const [second] = await provider.embedDocuments(['world']);

      expect(first).not.toEqual(second);
    });

    it('should return normalized vectors (unit length)', async () => {
      const [embedding] = await provider.embedDocuments(['test']);
      const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));

      expect(norm).toBeCloseTo(1.0, 5);
    });
  });

  describe('embedQuery', () => {
    it('should return array of correct dimension', async () => {
      const embedding = await provider.embedQuery('search query');

      expect(embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    });

    it('should match embedDocuments for same text', async () => {
      const query = await provider.embedQuery('test');
      const [doc] = await provider.embedDocuments(['test']);

      expect(query).toEqual(doc);
    });
  });
});

describe('embedding provider registry', () => {
  it('lists exactly the supported providers', () => {
    expect([...EMBEDDING_PROVIDER_NAMES].sort()).toEqual(['cohere', 'fixture', 'ollama']);
  });

  it('declares what each provider requires', () => {
    expect(EMBEDDING_PROVIDER_META.cohere.requires).toEqual(['apiKey']);
    expect(EMBEDDING_PROVIDER_META.ollama.requires).toEqual(['baseUrl']);
    expect(EMBEDDING_PROVIDER_META.fixture.requires).toEqual([]);
  });

  it('cohere keeps the identifier existing nodes carry', () => {
    expect(createEmbeddingProvider('cohere', { apiKey: 'k' }).model).toBe('cohere-embed-multilingual-v3.0');
  });

  it('ollama identifies as ollama:<model>:<tag>, defaulting to bge-m3:latest', () => {
    expect(EMBEDDING_PROVIDER_META.ollama.defaultModel).toBe('bge-m3');
    expect(createEmbeddingProvider('ollama', { baseUrl: 'http://o:11434' }).model).toBe('ollama:bge-m3:latest');
    expect(createEmbeddingProvider('ollama', { baseUrl: 'http://o:11434', model: 'bge-m3:latest' }).model)
      .toBe('ollama:bge-m3:latest');
    expect(createEmbeddingProvider('ollama', { baseUrl: 'http://o:11434', model: 'mxbai-embed-large:335m' }).model)
      .toBe('ollama:mxbai-embed-large:335m');
    // A registry port is not a tag
    expect(createEmbeddingProvider('ollama', { baseUrl: 'http://o:11434', model: 'reg:5000/ns/m' }).model)
      .toBe('ollama:reg:5000/ns/m:latest');
  });

  it('fixture identifies as fixture', () => {
    expect(createEmbeddingProvider('fixture', {}).model).toBe('fixture');
  });

  it('rejects an unknown provider, listing the supported ones', () => {
    expect(() => createEmbeddingProvider('jina', { apiKey: 'k' })).toThrow(/Unknown embedding provider: jina.*cohere, ollama, fixture/);
    // Not fooled by Object.prototype keys
    expect(() => createEmbeddingProvider('toString', {})).toThrow(/Unknown embedding provider/);
  });
});

describe('batching (registry maxBatch)', () => {
  it('splits cohere documents into requests of at most 96 texts', async () => {
    const fetchFn = fakeCohereFetch();
    const provider = createEmbeddingProvider('cohere', { apiKey: 'k' }, { fetch: fetchFn });
    const texts = Array.from({ length: 200 }, (_, i) => `text ${i}`);

    const vectors = await provider.embedDocuments(texts);

    expect(vectors).toHaveLength(200);
    expect(fetchFn.mock.calls.map((_, i) => (requestBody(fetchFn, i).texts as string[]).length)).toEqual([96, 96, 8]);
    // Order preserved across chunks
    expect((requestBody(fetchFn, 2).texts as string[])[7]).toBe('text 199');
  });

  it('embeds nothing for an empty list', async () => {
    const fetchFn = fakeCohereFetch();
    const provider = createEmbeddingProvider('cohere', { apiKey: 'k' }, { fetch: fetchFn });
    expect(await provider.embedDocuments([])).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('cohere adapter (injected fetch)', () => {
  it('sends the API model and search_document for documents', async () => {
    const fetchFn = fakeCohereFetch();
    await createEmbeddingProvider('cohere', { apiKey: 'k' }, { fetch: fetchFn }).embedDocuments(['a']);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cohere.com/v1/embed');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    expect(requestBody(fetchFn)).toMatchObject({ model: 'embed-multilingual-v3.0', input_type: 'search_document' });
  });

  it('honours a custom base URL (EMBEDDING_BASE_URL), trailing slash stripped', async () => {
    const fetchFn = fakeCohereFetch();
    const provider = createEmbeddingProvider('cohere', { apiKey: 'k', baseUrl: 'https://proxy.example/cohere/v1/' }, { fetch: fetchFn });
    await provider.embedDocuments(['a']);
    expect(fetchFn.mock.calls[0][0]).toBe('https://proxy.example/cohere/v1/embed');
    expect(provider.model).toBe('cohere-embed-multilingual-v3.0');
  });

  it('sends search_query for queries', async () => {
    const fetchFn = fakeCohereFetch();
    await createEmbeddingProvider('cohere', { apiKey: 'k' }, { fetch: fetchFn }).embedQuery('q');
    expect(requestBody(fetchFn)).toMatchObject({ model: 'embed-multilingual-v3.0', input_type: 'search_query', texts: ['q'] });
  });
});

describe('ollama adapter (injected fetch)', () => {
  it('strips trailing slashes from the base URL', async () => {
    const fetchFn = fakeOllamaFetch(1024);
    await createEmbeddingProvider('ollama', { baseUrl: 'http://ollama:11434//' }, { fetch: fetchFn }).embedQuery('q');
    expect(fetchFn.mock.calls[0][0]).toBe('http://ollama:11434/api/embeddings');
    expect(requestBody(fetchFn).model).toBe('bge-m3:latest');
  });

  it('a response without `embedding` is a readable error, not a TypeError', async () => {
    const fetchFn = fakeFetch(() => new Response('{}', { status: 200 }));
    const provider = createEmbeddingProvider('ollama', { baseUrl: 'http://ollama:11434' }, { fetch: fetchFn });
    await expect(provider.embedQuery('q')).rejects.toThrow(/Ollama returned no embedding for model "bge-m3:latest"/);
  });
});

describe('verifyEmbeddingDimensions (boot check)', () => {
  it('passes a provider producing EMBEDDING_DIMENSIONS', async () => {
    await expect(verifyEmbeddingDimensions(providerReporting(EMBEDDING_DIMENSIONS), 'fixture')).resolves.toBeUndefined();
  });

  it('refuses a 768-dimensional provider, naming provider, model and both sizes', async () => {
    await expect(verifyEmbeddingDimensions(providerReporting(768), 'cohere')).rejects.toThrow(
      'provider "cohere" with model "fake-model" produces 768-dimensional vectors, but this install requires 1024'
    );
  });

  it('checks statically known dimensions without calling the provider', async () => {
    const provider = providerReporting(EMBEDDING_DIMENSIONS);
    const embedQuery = vi.spyOn(provider, 'embedQuery');
    await verifyEmbeddingDimensions(provider, 'cohere');
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it('probes ollama with one embedding and accepts a 1024-dim model', async () => {
    const fetchFn = fakeOllamaFetch(1024);
    const provider = createEmbeddingProvider('ollama', { baseUrl: 'http://ollama:11434' }, { fetch: fetchFn });
    await verifyEmbeddingDimensions(provider, 'ollama');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe('http://ollama:11434/api/embeddings');
    expect(requestBody(fetchFn).model).toBe('bge-m3:latest');
  });

  it('probes ollama and refuses a 768-dim model', async () => {
    const provider = createEmbeddingProvider(
      'ollama',
      { baseUrl: 'http://ollama:11434', model: 'nomic-embed-text' },
      { fetch: fakeOllamaFetch(768) }
    );
    await expect(verifyEmbeddingDimensions(provider, 'ollama')).rejects.toThrow(
      'provider "ollama" with model "ollama:nomic-embed-text:latest" produces 768-dimensional vectors, but this install requires 1024'
    );
  });
});

describe('ollama boot probe failures', () => {
  const baseUrl = 'http://ollama:11434';

  function probe(fetchFn: FakeFetch, sleep = vi.fn(async (_ms: number) => {})) {
    const provider = createEmbeddingProvider('ollama', { baseUrl }, { fetch: fetchFn });
    return { result: verifyEmbeddingDimensions(provider, 'ollama', { baseUrl, sleep }), sleep };
  }

  it('connection refused: retries with backoff, then names provider, URL and model', async () => {
    const fetchFn = fakeFetch(() => { throw new TypeError('fetch failed: ECONNREFUSED'); });
    const { result, sleep } = probe(fetchFn);
    await expect(result).rejects.toThrow(
      /^Embedding provider probe failed: provider "ollama" \(model "ollama:bge-m3:latest", base URL http:\/\/ollama:11434\) did not answer after 5 attempts: .*ECONNREFUSED/
    );
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 3000, 4000]);
  });

  it('hung server: each attempt is cut at 10s, so boot gives up within ~60s', async () => {
    vi.useFakeTimers();
    try {
      // Never answers (the adapter's own 60s runtime timeout is not reached first).
      const fetchFn = fakeFetch(() => new Promise<Response>(() => {}));
      const { result, sleep } = probe(fetchFn);
      const settled = result.catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(5 * 10_000);
      const err = await settled;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/did not answer after 5 attempts: no answer within 10s/);
      expect(fetchFn).toHaveBeenCalledTimes(5);
      // Probe time (5 x 10s, fake clock) plus backoff (1+2+3+4s, injected sleep) = 60s
      const backoff = sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0);
      expect(5 * 10_000 + backoff).toBe(60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers when a cold server answers on a later attempt', async () => {
    let calls = 0;
    const fetchFn = fakeFetch(() => {
      if (++calls < 3) throw new TypeError('ECONNREFUSED');
      return new Response(JSON.stringify({ embedding: Array(1024).fill(0) }), { status: 200 });
    });
    await expect(probe(fetchFn).result).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('500: retried, then fails with the status', async () => {
    const fetchFn = fakeFetch(() => new Response('loading model', { status: 500 }));
    await expect(probe(fetchFn).result).rejects.toThrow(/probe failed.*did not answer after 5 attempts: Ollama API error: 500 loading model/);
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it('404 (model not pulled): fails at once, not as a dimension mismatch', async () => {
    const fetchFn = fakeFetch(() => new Response('{"error":"model not found"}', { status: 404 }));
    const { result, sleep } = probe(fetchFn);
    await expect(result).rejects.toThrow(/probe failed.*base URL http:\/\/ollama:11434\) rejected the request: Ollama API error: 404/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('`{}` body: fails at once with a readable message', async () => {
    const fetchFn = fakeFetch(() => new Response('{}', { status: 200 }));
    await expect(probe(fetchFn).result).rejects.toThrow(/probe failed.*rejected the request: Ollama returned no embedding/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('createProviderFromEnv', () => {
  it('builds and verifies the provider the env selects', async () => {
    const env = embeddingEnvSchema.parse({ EMBEDDING_PROVIDER: 'fixture' });
    expect((await createProviderFromEnv(env)).model).toBe('fixture');
  });

  it('builds cohere from COHERE_API_KEY alone without a network call (production config)', async () => {
    const fetchFn = fakeCohereFetch();
    const env = embeddingEnvSchema.parse({ COHERE_API_KEY: 'k' });
    const provider = await createProviderFromEnv(env, { fetch: fetchFn });
    expect(provider.model).toBe('cohere-embed-multilingual-v3.0');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('uses generic EMBEDDING_BASE_URL / EMBEDDING_MODEL for ollama', async () => {
    const fetchFn = fakeOllamaFetch(1024);
    const env = embeddingEnvSchema.parse({
      EMBEDDING_PROVIDER: 'ollama', EMBEDDING_BASE_URL: 'http://gen:11434/', EMBEDDING_MODEL: 'bge-m3:567m',
    });
    expect((await createProviderFromEnv(env, { fetch: fetchFn, ...noSleep })).model).toBe('ollama:bge-m3:567m');
    expect(fetchFn.mock.calls[0][0]).toBe('http://gen:11434/api/embeddings');
  });

  it('cohere reads EMBEDDING_BASE_URL from the env', async () => {
    const fetchFn = fakeCohereFetch();
    const env = embeddingEnvSchema.parse({ COHERE_API_KEY: 'k', EMBEDDING_BASE_URL: 'http://cohere-proxy:8080/v1' });
    await (await createProviderFromEnv(env, { fetch: fetchFn })).embedQuery('q');
    expect(fetchFn.mock.calls[0][0]).toBe('http://cohere-proxy:8080/v1/embed');
  });

  it('cohere ignores a stale OLLAMA_URL: default base URL, no boot failure', async () => {
    const fetchFn = fakeCohereFetch();
    const env = embeddingEnvSchema.parse({ COHERE_API_KEY: 'k', OLLAMA_URL: 'not a url' });
    const provider = await createProviderFromEnv(env, { fetch: fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    await provider.embedQuery('q');
    expect(fetchFn.mock.calls[0][0]).toBe('https://api.cohere.com/v1/embed');
  });

  it('rejects at boot when the ollama model has the wrong dimension', async () => {
    const env = embeddingEnvSchema.parse({ EMBEDDING_PROVIDER: 'ollama', OLLAMA_URL: 'http://ollama:11434' });
    await expect(createProviderFromEnv(env, { fetch: fakeOllamaFetch(768), ...noSleep })).rejects.toThrow(/dimension mismatch/);
  });
});

describe('entrypoints build the provider through createProviderFromEnv', () => {
  const srcDir = fileURLToPath(new URL('../', import.meta.url));
  const IMPORTS_EMBED = /from\s+['"](?:\.\.?\/)+embed\.js['"]/;
  const BUILDS_PROVIDER = /\bcreate\w*(?:Provider|Adapter|ProviderFromEnv)\(/;

  /** Production entrypoints: src/index.ts, src/bin/*.ts and src/benchmarks/*.ts, tests excluded. */
  function entrypoints(): string[] {
    const inDir = (dir: string) =>
      readdirSync(`${srcDir}${dir}`)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .map((f) => `${dir}/${f}`);
    return ['index.ts', ...inDir('bin'), ...inDir('benchmarks')];
  }

  const source = (file: string) => readFileSync(`${srcDir}${file}`, 'utf8');
  // Entrypoints that import embed.js and build a provider with something from it
  const builders = entrypoints().filter((file) => IMPORTS_EMBED.test(source(file)) && BUILDS_PROVIDER.test(source(file)));

  it('finds the known entrypoints (the scan is not vacuous)', () => {
    expect(builders).toEqual(expect.arrayContaining(['index.ts', 'bin/mcp.ts', 'bin/reembed.ts', 'benchmarks/runner.ts']));
  });

  it.each(builders)('%s', (file) => {
    const text = source(file);
    expect(text).toMatch(/\bcreateProviderFromEnv\(/);
    expect(text).not.toMatch(/\bcreate(Embedding|Cohere|Ollama|Fixture)Provider\(/);
    expect(text).not.toMatch(/\bcreate(Cohere|Ollama|Fixture)Adapter\(/);
  });
});
