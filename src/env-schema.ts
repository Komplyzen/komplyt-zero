/**
 * Server environment schema. Pure: nothing here reads process.env, so tests
 * and tools can validate any map. env.ts applies it to process.env.
 */
import { z } from 'zod';
import { blankToUndefined, envFlag, formatEnvIssues } from './env-helpers.js';
import { embeddingEnvShape, checkEmbeddingEnv, resolveEmbeddingEnv } from './env-embedding.js';
import { authEnvShape, checkAuthEnv } from './env-auth.js';

const envSchema = z.object({
  // Database
  KG_DB_URL: z.string().url(),
  KG_DB_USER: z.string(),
  KG_DB_PASS: z.string(),
  KG_DB_NS: z.string().default('kg'),
  KG_DB_NAME: z.string().default('main'),
  KG_JWT_SECRET: z.string().min(32),

  // Auth mode: komplyt (default, verifies Komplyt JWTs) or local (no token checking, one fixed
  // user and tenant, for self-hosting). KG_AUTH_MODE, KG_LOCAL_SUB, KG_LOCAL_TENANT. See env-auth.ts.
  ...authEnvShape,

  // Komplyt Auth (required for server, optional for CLI tools)
  KOMPLYT_JWKS_URL: z.string().url().optional(),
  KOMPLYT_ISSUER: z.string().url().optional(),
  KOMPLYT_AUDIENCE: z
    .string()
    .default('kg-server')
    .transform((s) => s.split(',')),

  // Embedding provider: EMBEDDING_PROVIDER, EMBEDDING_API_KEY, EMBEDDING_BASE_URL,
  // EMBEDDING_MODEL, legacy aliases (COHERE_API_KEY, OLLAMA_URL, OLLAMA_MODEL,
  // KG_EMBED_FIXTURES). See env-embedding.ts.
  ...embeddingEnvShape,

  // Server (required for HTTP server, optional for CLI)
  KG_PUBLIC_URL: z.string().url().optional(),
  CORS_ORIGINS: z.string().transform(s => s.split(',')).optional(),
  LISTEN_ADDR: z.string().default('0.0.0.0:3000'),
  // Local auth mode only: extra Host header values to accept besides loopback (reverse proxy, LAN name).
  KG_LOCAL_ALLOWED_HOSTS: z.string().transform(s => s.split(',').map(h => h.trim().toLowerCase()).filter(Boolean)).optional(),

  // MCP server identity
  MCP_SERVER_NAME: z.string().default('komplyt-temporal-lobe'),

  // Rate limiting
  TRUSTED_PROXY_CIDR: z.string().optional(),

  // Container purge job (CAP-1): shared secret for the GH Actions machine caller.
  // Absent OR empty = purge endpoint disabled (404s) — empty-string preprocessing
  // keeps the .env.example template (`PURGE_JOB_SECRET=`) from failing boot
  // validation. Min 32 chars ≈ high-entropy requirement.
  PURGE_JOB_SECRET: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(32).optional()
  ),

  // kg_auth_session pruning (every scoped request signs in and leaves a row).
  // Retention must exceed the longest-lived scoped connection; the default is a day.
  // Blank values (a template line like `KG_SESSION_PRUNE=`) mean "use the default".
  KG_SESSION_PRUNE: envFlag(true),
  KG_SESSION_RETENTION_HOURS: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(24)),
  KG_SESSION_PRUNE_INTERVAL_MINUTES: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(60)),

  // Optional bearer token for /metrics and /pool-metrics. Absent or blank = open (as before).
  METRICS_TOKEN: z.preprocess(blankToUndefined, z.string().min(16).optional()),

  // Optional
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Better Stack logging
  LOGTAIL_TOKEN: z.string().optional(),

  // Dev mode: surface actual errors in JSON-RPC responses
  DEV_SURFACE_ERRORS: envFlag(false),
  // Hosted deploys set this so a build without src/ee/ refuses to start.
  // Parsed explicitly: z.coerce.boolean() would read the string 'false' as true.
  KG_REQUIRE_EE: z.enum(['true', 'false', '1', '0']).default('false').transform((v) => v === 'true' || v === '1'),

  // OpenAI marketplace domain verification challenge
  OPENAI_APPS_CHALLENGE: z.string().optional(),

  // Vercel protection bypass for staging JWKS fetch
  VERCEL_BYPASS_SECRET: z.string().optional(),
})
  .superRefine(checkEmbeddingEnv)
  .superRefine(checkAuthEnv)
  .transform(resolveEmbeddingEnv);

export type Env = z.infer<typeof envSchema>;

/** Parse and validate an environment map. Throws listing every invalid variable. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Environment validation failed:\n${formatEnvIssues(result.error)}`);
  }
  return result.data;
}
