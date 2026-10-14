import { parseEnv, type Env } from './env-schema.js';

export { parseEnv, type Env };

let _env: Env | null = null;

/**
 * Parse and validate environment variables.
 * Throws on validation failure with detailed error messages.
 * Caches result after first successful parse.
 */
export function getEnv(): Env {
  if (_env) return _env;

  _env = parseEnv(process.env);
  return _env;
}

/**
 * Reset cached env (for testing)
 */
export function resetEnv(): void {
  _env = null;
}

// Convenience export for server code (validates on import)
export const env = getEnv();
