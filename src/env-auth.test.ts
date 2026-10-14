import { describe, it, expect } from 'vitest';
import { parseEnv } from './env-schema.js';

// The minimum a server env needs besides auth settings (fixture embeddings need no key).
const BASE = {
  KG_DB_URL: 'ws://localhost:8000',
  KG_DB_USER: 'root',
  KG_DB_PASS: 'root',
  KG_JWT_SECRET: 'unit-test-secret-at-least-32-characters!!',
  EMBEDDING_PROVIDER: 'fixture',
};

function parse(vars: Record<string, string | undefined>) {
  return parseEnv({ ...BASE, ...vars });
}

describe('KG_AUTH_MODE', () => {
  it('defaults to komplyt, which is today\'s behaviour', () => {
    expect(parse({}).KG_AUTH_MODE).toBe('komplyt');
  });

  it('treats a blank value as unset', () => {
    expect(parse({ KG_AUTH_MODE: '  ' }).KG_AUTH_MODE).toBe('komplyt');
  });

  it('accepts komplyt and local, in any case', () => {
    expect(parse({ KG_AUTH_MODE: 'komplyt' }).KG_AUTH_MODE).toBe('komplyt');
    expect(parse({ KG_AUTH_MODE: 'Local' }).KG_AUTH_MODE).toBe('local');
  });

  it('rejects any other value, naming the variable', () => {
    expect(() => parse({ KG_AUTH_MODE: 'none' })).toThrow(/KG_AUTH_MODE/);
    expect(() => parse({ KG_AUTH_MODE: 'off' })).toThrow(/KG_AUTH_MODE/);
  });

  it('refuses local together with KOMPLYT_JWKS_URL (protects the hosted deployment)', () => {
    expect(() =>
      parse({ KG_AUTH_MODE: 'local', KOMPLYT_JWKS_URL: 'https://komplyt.com/.well-known/jwks.json' })
    ).toThrow(/KG_AUTH_MODE=local.*KOMPLYT_JWKS_URL/);
  });

  it('refuses local together with KOMPLYT_ISSUER as well (a deployment that verifies tokens)', () => {
    expect(() => parse({ KG_AUTH_MODE: 'local', KOMPLYT_ISSUER: 'https://komplyt.com' })).toThrow(
      /KG_AUTH_MODE=local.*KOMPLYT_ISSUER/
    );
  });

  it('allows komplyt with a JWKS URL, and local without one', () => {
    expect(
      parse({ KOMPLYT_JWKS_URL: 'https://komplyt.com/.well-known/jwks.json' }).KG_AUTH_MODE
    ).toBe('komplyt');
    expect(parse({ KG_AUTH_MODE: 'local' }).KG_AUTH_MODE).toBe('local');
  });
});

describe('KG_LOCAL_SUB / KG_LOCAL_TENANT', () => {
  it('default to "local"', () => {
    const env = parse({ KG_AUTH_MODE: 'local' });
    expect(env.KG_LOCAL_SUB).toBe('local');
    expect(env.KG_LOCAL_TENANT).toBe('local');
  });

  it('can be set, and blank means the default', () => {
    const env = parse({ KG_AUTH_MODE: 'local', KG_LOCAL_SUB: 'ada', KG_LOCAL_TENANT: 'lab-1' });
    expect(env.KG_LOCAL_SUB).toBe('ada');
    expect(env.KG_LOCAL_TENANT).toBe('lab-1');
    expect(parse({ KG_LOCAL_SUB: '', KG_LOCAL_TENANT: ' ' }).KG_LOCAL_TENANT).toBe('local');
  });

  // The values become principal ids ("principal:user_<sub>") that are split on ':' later, so
  // a colon or whitespace in them would corrupt every principal check.
  it.each(['a:b', 'has space', 'x/y', 'é', 'a'.repeat(65)])('rejects the unsafe value %j', (bad) => {
    expect(() => parse({ KG_LOCAL_SUB: bad })).toThrow(/KG_LOCAL_SUB/);
    expect(() => parse({ KG_LOCAL_TENANT: bad })).toThrow(/KG_LOCAL_TENANT/);
  });
});
