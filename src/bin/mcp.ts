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
import { buildServerInfo } from '../server-info.js';
import { getEnv } from '../env.js';
import { publishSigninSecret } from '../signin-secret.js';
import { logLocalModeWarning } from '../auth-local.js';
import { executeStdioToolCallScoped, rejectBeforeStartup, errorResult } from './stdio-tool-call.js';
import { createStartup } from './stdio-startup.js';
import { trackInFlight } from './stdio-lifecycle.js';
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
    throw new Error('Invalid token. Run `kg auth login` again.');
  }
}

const SHUTDOWN_GRACE_MS = 2_000;
/** After stdin closes, requests already received get this long to be answered. */
const DRAIN_MS = 10_000;

async function exitAfterCleanup(): Promise<never> {
  await Promise.race([gracefulShutdown(), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS))]);
  process.exit(0);
}

function flushStdout(): Promise<void> {
  return new Promise((resolve) => process.stdout.write('', () => resolve()));
}

async function main() {
  const env = getEnv();

  // Runs in the background: `initialize` and `tools/list` need none of it, and a server without a
  // reachable database must still answer them (directory scanners, clients with a bad config).
  // Each tool call signs in on its own over the pool's shared socket (see
  // executeStdioToolCallScoped): a held scoped session would outlive its kg_auth_session row, and
  // a socket per call would pay TCP + TLS every time.
  const startup = createStartup(async () => {
    const claims = await resolveStdioClaims(env, loadClaimsFromCredentials);
    await prepareStdioAuth(env, { warn: logLocalModeWarning, publish: () => publishSigninSecret() });
    const embed = await createProviderFromEnv(getEnv());
    await (await pooledDbFactory.createScoped(claims)).close();
    return { claims, embed };
  });
  startup.begin();

  const server = new Server(
    buildServerInfo(env.MCP_SERVER_NAME, env.KG_PUBLIC_URL),
    { capabilities: { tools: {} } },
  );

  let kgSessionId: string | null = null;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listToolEntries(toolRegistry),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const rejected = rejectBeforeStartup(toolRegistry, name, args, kgSessionId);
    if (rejected) {
      const { sessionId: _unchanged, ...result } = rejected;
      return result;
    }

    let started;
    try {
      started = await startup.ready();
    } catch (err) {
      const { sessionId: _unchanged, ...result } = errorResult((err as Error).message, kgSessionId);
      return result;
    }

    // Lookup, scope check, Zod validation, execute, session tracking live in
    // stdio-tool-call.ts so they are unit-tested.
    const { sessionId, ...result } = await executeStdioToolCallScoped(
      { registry: toolRegistry, dbFactory: pooledDbFactory, ...started },
      name,
      args,
      kgSessionId
    );
    kgSessionId = sessionId;
    return result;
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const inFlight = trackInFlight(transport);

  // The SDK transport ignores a closing stdin, and the pooled socket would keep the process alive
  // as an orphan: answer what was received, then leave.
  process.stdin.once('end', async () => {
    await inFlight.idle(DRAIN_MS);
    await flushStdout();
    await exitAfterCleanup();
  });
  process.on('SIGTERM', exitAfterCleanup);
  process.on('SIGINT', exitAfterCleanup);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
