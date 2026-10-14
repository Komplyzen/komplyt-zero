import { describe, it, expect } from 'vitest';
import { parseEnv } from './env-schema.js';

// The minimum a server env needs besides embedding settings.
const BASE = {
  KG_DB_URL: 'ws://localhost:8000',
  KG_DB_USER: 'root',
  KG_DB_PASS: 'root',
  KG_JWT_SECRET: 'unit-test-secret-at-least-32-characters!!',
};

function parse(vars: Record<string, string | undefined>) {
  return parseEnv({ ...BASE, ...vars });
}

describe('embedding provider env', () => {
  it('cohere is the default and accepts COHERE_API_KEY alone (production config)', () => {
    const env = parse({ COHERE_API_KEY: 'prod-key' });
    expect(env.EMBEDDING_PROVIDER).toBe('cohere');
    expect(env.EMBEDDING_API_KEY).toBe('prod-key');
  });

  it('cohere accepts EMBEDDING_API_KEY, which wins over COHERE_API_KEY', () => {
    expect(parse({ EMBEDDING_PROVIDER: 'cohere', EMBEDDING_API_KEY: 'new-key' }).EMBEDDING_API_KEY).toBe('new-key');
    expect(parse({ EMBEDDING_API_KEY: 'new-key', COHERE_API_KEY: 'old-key' }).EMBEDDING_API_KEY).toBe('new-key');
  });

  it('cohere with neither key fails, naming EMBEDDING_API_KEY and the fallback', () => {
    expect(() => parse({ EMBEDDING_PROVIDER: 'cohere' })).toThrow(/EMBEDDING_API_KEY: .*COHERE_API_KEY/);
  });

  it('blank keys count as unset', () => {
    expect(() => parse({ EMBEDDING_API_KEY: '  ', COHERE_API_KEY: '' })).toThrow(/EMBEDDING_API_KEY/);
  });

  it('ollama needs no key but a base URL; OLLAMA_URL is accepted', () => {
    const env = parse({ EMBEDDING_PROVIDER: 'ollama', OLLAMA_URL: 'http://localhost:11434' });
    expect(env.EMBEDDING_PROVIDER).toBe('ollama');
    expect(env.EMBEDDING_API_KEY).toBeUndefined();
    expect(env.EMBEDDING_BASE_URL).toBe('http://localhost:11434');
    expect(env.EMBEDDING_MODEL).toBe('bge-m3');
  });

  it('ollama does not borrow COHERE_API_KEY', () => {
    const env = parse({ EMBEDDING_PROVIDER: 'ollama', OLLAMA_URL: 'http://localhost:11434', COHERE_API_KEY: 'k' });
    expect(env.EMBEDDING_API_KEY).toBeUndefined();
  });

  it('ollama without a base URL fails, naming EMBEDDING_BASE_URL and the fallback', () => {
    expect(() => parse({ EMBEDDING_PROVIDER: 'ollama' })).toThrow(/EMBEDDING_BASE_URL: required for EMBEDDING_PROVIDER=ollama \(OLLAMA_URL/);
  });

  it('generic EMBEDDING_BASE_URL / EMBEDDING_MODEL configure ollama (trailing slash stripped)', () => {
    const env = parse({ EMBEDDING_PROVIDER: 'ollama', EMBEDDING_BASE_URL: 'http://gen:11434/', EMBEDDING_MODEL: 'bge-m3:567m' });
    expect(env.EMBEDDING_BASE_URL).toBe('http://gen:11434');
    expect(env.EMBEDDING_MODEL).toBe('bge-m3:567m');
  });

  it('generic names win over the OLLAMA_* aliases', () => {
    const env = parse({
      EMBEDDING_PROVIDER: 'ollama',
      EMBEDDING_BASE_URL: 'http://gen:11434', OLLAMA_URL: 'http://old:11434',
      EMBEDDING_MODEL: 'gen-model', OLLAMA_MODEL: 'old-model',
    });
    expect(env.EMBEDDING_BASE_URL).toBe('http://gen:11434');
    expect(env.EMBEDDING_MODEL).toBe('gen-model');
  });

  it('OLLAMA_MODEL alone is honoured', () => {
    expect(parse({ EMBEDDING_PROVIDER: 'ollama', OLLAMA_URL: 'http://o:11434', OLLAMA_MODEL: 'old-model' }).EMBEDDING_MODEL)
      .toBe('old-model');
  });

  it('OLLAMA_* aliases are ignored for other providers', () => {
    const env = parse({ COHERE_API_KEY: 'k', OLLAMA_URL: 'http://o:11434', OLLAMA_MODEL: 'm' });
    expect(env.EMBEDDING_BASE_URL).toBeUndefined();
    expect(env.EMBEDDING_MODEL).toBe('embed-multilingual-v3.0');
  });

  it('cohere has a fixed model: EMBEDDING_MODEL may only name it', () => {
    expect(parse({ COHERE_API_KEY: 'k', EMBEDDING_MODEL: 'embed-multilingual-v3.0' }).EMBEDDING_MODEL)
      .toBe('embed-multilingual-v3.0');
    expect(() => parse({ COHERE_API_KEY: 'k', EMBEDDING_MODEL: 'embed-english-light-v3.0' }))
      .toThrow(/EMBEDDING_MODEL: EMBEDDING_PROVIDER=cohere has a fixed model/);
  });

  it('rejects a malformed base URL the provider reads, naming the variable it came from', () => {
    expect(() => parse({ EMBEDDING_PROVIDER: 'ollama', EMBEDDING_BASE_URL: 'not a url' })).toThrow(/EMBEDDING_BASE_URL: not a valid URL/);
    expect(() => parse({ EMBEDDING_PROVIDER: 'ollama', OLLAMA_URL: 'not a url' })).toThrow(/OLLAMA_URL: not a valid URL/);
    expect(() => parse({ COHERE_API_KEY: 'k', EMBEDDING_BASE_URL: 'not a url' })).toThrow(/EMBEDDING_BASE_URL: not a valid URL/);
  });

  it('cohere + garbage OLLAMA_URL / OLLAMA_MODEL boots (settings it does not read are ignored)', () => {
    const env = parse({ COHERE_API_KEY: 'k', OLLAMA_URL: 'garbage', OLLAMA_MODEL: 'nomic-embed-text' });
    expect(env.EMBEDDING_PROVIDER).toBe('cohere');
    expect(env.EMBEDDING_BASE_URL).toBeUndefined();
    expect(env.EMBEDDING_MODEL).toBe('embed-multilingual-v3.0');
  });

  it('cohere honours EMBEDDING_BASE_URL', () => {
    expect(parse({ COHERE_API_KEY: 'k', EMBEDDING_BASE_URL: 'https://proxy.example/v1/' }).EMBEDDING_BASE_URL)
      .toBe('https://proxy.example/v1');
  });

  it('fixture reads no embedding setting: stray URL / model / key values are ignored', () => {
    const env = parse({
      EMBEDDING_PROVIDER: 'fixture', EMBEDDING_BASE_URL: 'garbage', EMBEDDING_MODEL: 'bge-m3', EMBEDDING_API_KEY: 'k',
    });
    expect(env.EMBEDDING_PROVIDER).toBe('fixture');
    expect(env.EMBEDDING_BASE_URL).toBeUndefined();
    expect(env.EMBEDDING_API_KEY).toBeUndefined();
    expect(env.EMBEDDING_MODEL).toBe('fixture');
  });

  it('fixture needs no key', () => {
    expect(parse({ EMBEDDING_PROVIDER: 'fixture' }).EMBEDDING_PROVIDER).toBe('fixture');
  });

  it('rejects an unknown provider', () => {
    expect(() => parse({ EMBEDDING_PROVIDER: 'openai', EMBEDDING_API_KEY: 'k' })).toThrow(/EMBEDDING_PROVIDER/);
  });

  it('KG_EMBED_FIXTURES=true is a legacy alias for fixture', () => {
    expect(parse({ KG_EMBED_FIXTURES: 'true' }).EMBEDDING_PROVIDER).toBe('fixture');
  });

  it('KG_EMBED_FIXTURES=true with EMBEDDING_PROVIDER=fixture is fine (CI sets both)', () => {
    expect(parse({ KG_EMBED_FIXTURES: 'true', EMBEDDING_PROVIDER: 'fixture' }).EMBEDDING_PROVIDER).toBe('fixture');
  });

  it('KG_EMBED_FIXTURES=true with another explicit provider is a conflict naming both', () => {
    expect(() => parse({ KG_EMBED_FIXTURES: 'true', EMBEDDING_PROVIDER: 'cohere', COHERE_API_KEY: 'k' }))
      .toThrow(/KG_EMBED_FIXTURES: KG_EMBED_FIXTURES=true conflicts with EMBEDDING_PROVIDER=cohere/);
  });

  it("KG_EMBED_FIXTURES='false' is false (no longer coerced to true)", () => {
    const env = parse({ KG_EMBED_FIXTURES: 'false', COHERE_API_KEY: 'k' });
    expect(env.KG_EMBED_FIXTURES).toBe(false);
    expect(env.EMBEDDING_PROVIDER).toBe('cohere');
  });
});

describe('boolean switches', () => {
  const withKey = { EMBEDDING_PROVIDER: 'fixture' };

  it("DEV_SURFACE_ERRORS='false' is false", () => {
    expect(parse({ ...withKey, DEV_SURFACE_ERRORS: 'false' }).DEV_SURFACE_ERRORS).toBe(false);
  });

  it('DEV_SURFACE_ERRORS accepts true/1/yes and defaults to false', () => {
    expect(parse({ ...withKey, DEV_SURFACE_ERRORS: 'TRUE' }).DEV_SURFACE_ERRORS).toBe(true);
    expect(parse({ ...withKey, DEV_SURFACE_ERRORS: '1' }).DEV_SURFACE_ERRORS).toBe(true);
    expect(parse({ ...withKey }).DEV_SURFACE_ERRORS).toBe(false);
    expect(parse({ ...withKey, DEV_SURFACE_ERRORS: '' }).DEV_SURFACE_ERRORS).toBe(false);
  });

  it('rejects a value that is not a switch', () => {
    expect(() => parse({ ...withKey, DEV_SURFACE_ERRORS: 'maybe' })).toThrow(/DEV_SURFACE_ERRORS/);
  });
});

describe('session pruning switch', () => {
  const base = { EMBEDDING_PROVIDER: 'fixture' };

  it('KG_SESSION_PRUNE defaults to true', () => {
    expect(parse(base).KG_SESSION_PRUNE).toBe(true);
  });

  it("KG_SESSION_PRUNE='off' is false", () => {
    expect(parse({ ...base, KG_SESSION_PRUNE: 'off' }).KG_SESSION_PRUNE).toBe(false);
  });
});
