#!/usr/bin/env node
// MUST stay the first import: sends logs to stderr before any logger is built,
// keeping pino output off the stdout JSON-RPC channel. See stdio-log-dest.ts.
import './stdio-log-dest.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile, writeFile, access, constants, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import type { KgTokenPayload } from '../contracts.js';
import { pooledDbFactory, gracefulShutdown } from '../pool.js';
import { createProviderFromEnv } from '../embed.js';
import { toolRegistry } from '../tools/index.js';
import { listToolEntries } from '../tool-list.js';
import { getEnv } from '../env.js';
import { publishSigninSecret } from '../signin-secret.js';
import { logLocalModeWarning } from '../auth-local.js';
import { executeStdioToolCallScoped } from './stdio-tool-call.js';
import { prepareStdioAuth, resolveStdioClaims } from './stdio-claims.js';

const CREDENTIALS_PATH = join(homedir(), '.kg', 'credentials.json');
const KEYCHAIN_SERVICE = 'kg-cli';

interface Credentials {
  access_token: string;
  access_token_expires_at: string;
  user_email: string;
  tenantId: string;
}

async function loadCredentials(): Promise<Credentials> {
  try {
    const stats = await stat(CREDENTIALS_PATH);
    const mode = stats.mode & 0o777;
    if (mode !== 0o600) {
      console.error(`Warning: ${CREDENTIALS_PATH} has insecure permissions (${mode.toString(8)}). Should be 600.`);
    }
    await access(CREDENTIALS_PATH, constants.R_OK);
  } catch {
    throw new Error('No credentials found. Run `kg auth login` to authenticate.');
  }

  const content = await readFile(CREDENTIALS_PATH, 'utf-8');
  return JSON.parse(content);
}

async function refreshTokenIfNeeded(creds: Credentials): Promise<string> {
  const expiresAt = new Date(creds.access_token_expires_at);
  const now = new Date();
  const fiveMinutes = 5 * 60 * 1000;

  if (expiresAt.getTime() - now.getTime() >= fiveMinutes) {
    return creds.access_token;
  }

  console.error('Access token expiring soon, refreshing...');

  // Loaded on demand: keytar is a native module, and local auth mode never needs it.
  const { default: keytar } = await import('keytar');
  const refreshToken = await keytar.getPassword(KEYCHAIN_SERVICE, 'refresh_token');
  if (!refreshToken) {
    throw new Error('Refresh token not found. Run `kg auth login` again.');
  }

  const issuer = process.env.KOMPLYT_ISSUER || 'https://komplyt.com';
  const response = await fetch(`${issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'kg-cli',
    }),
  });

  if (!response.ok) {
    throw new Error('Token refresh failed. Run `kg auth login` again.');
  }

  const tokens = (await response.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token: string;
  };

  creds.access_token = tokens.access_token;
  creds.access_token_expires_at = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  await writeFile(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
  await keytar.setPassword(KEYCHAIN_SERVICE, 'refresh_token', tokens.refresh_token);

  return tokens.access_token;
}

/** The claims of the user who ran `kg auth login` (komplyt mode). */
async function loadClaimsFromCredentials(): Promise<KgTokenPayload> {
  const creds = await loadCredentials();
  const accessToken = await refreshTokenIfNeeded(creds);

  // Parse JWT claims locally (skip JWKS validation for CLI - the access token
  // came from our OAuth flow and is already trusted)
  try {
    const [, payloadB64] = accessToken.split('.');
    if (!payloadB64) throw new Error('Invalid token format');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

    if (!payload.sub || !payload.tenantId || !Array.isArray(payload.projects) || !payload.scope) {
      throw new Error('Missing required claims');
    }

    const { buildPrincipals } = await import('../auth.js');
    return {
      sub: payload.sub,
      tenantId: payload.tenantId,
      projects: payload.projects,
      scope: payload.scope,
      principals: payload.principals ?? buildPrincipals(payload.sub, payload.tenantId, payload.projects),
      tier: payload.tier ?? 'free',
    };
  } catch {
    console.error('Invalid token. Run `kg auth login` again.');
    process.exit(1);
  }
}

async function main() {
  const env = getEnv();
  const claims = await resolveStdioClaims(env, loadClaimsFromCredentials);

  await prepareStdioAuth(env, { warn: logLocalModeWarning, publish: () => publishSigninSecret() });

  // Initialize embedding provider; a dimension mismatch rejects here and
  // main().catch exits non-zero before the stdio server starts.
  const embed = await createProviderFromEnv(getEnv());

  // Fail fast on bad credentials or a rejected signin, then release the
  // session. Each tool call signs in on its own over the pool's shared socket
  // (see executeStdioToolCallScoped): a held scoped session would outlive its
  // kg_auth_session row, and a socket per call would pay TCP + TLS every time.
  await (await pooledDbFactory.createScoped(claims)).close();

  const shutdown = async () => {
    await gracefulShutdown();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const server = new Server(
    { name: 'kg-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  let kgSessionId: string | null = null;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listToolEntries(toolRegistry),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Lookup, scope check, Zod validation, execute, session tracking live in
    // stdio-tool-call.ts so they are unit-tested.
    const { sessionId, ...result } = await executeStdioToolCallScoped(
      { registry: toolRegistry, dbFactory: pooledDbFactory, embed, claims },
      name,
      args,
      kgSessionId
    );
    kgSessionId = sessionId;
    return result;
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
