#!/usr/bin/env node
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { createHash, randomBytes } from 'crypto';
import { mkdir, writeFile, unlink, readFile } from 'fs/promises';
import { homedir } from 'os';
import { join, dirname } from 'path';
import keytar from 'keytar';
import open from 'open';

const KEYCHAIN_SERVICE = 'kg-cli';
const CREDENTIALS_PATH = join(homedir(), '.kg', 'credentials.json');

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

async function login() {
  const issuer = process.env.KOMPLYT_ISSUER || 'https://komplyt.com';

  // Generate PKCE challenge and CSRF state
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(16));

  // Start local server to receive callback (5 min timeout)
  const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
  const port = await new Promise<number>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      server.close();
      reject(new Error('Login timed out. Please try again.'));
    }, LOGIN_TIMEOUT_MS);

    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      // Validate CSRF state parameter
      const returnedState = url.searchParams.get('state');
      if (returnedState !== state) {
        res.writeHead(400);
        res.end('Invalid state parameter - possible CSRF attack');
        clearTimeout(timeoutId);
        server.close();
        reject(new Error('Invalid state parameter'));
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400);
        res.end(`Error: ${error}`);
        clearTimeout(timeoutId);
        server.close();
        reject(new Error(error));
        return;
      }

      if (!code) {
        res.writeHead(400);
        res.end('Missing authorization code');
        clearTimeout(timeoutId);
        server.close();
        reject(new Error('Missing authorization code'));
        return;
      }

      try {
        // Exchange code for tokens
        const actualPort = (server.address() as AddressInfo).port;
        const tokenResponse = await fetch(`${issuer}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: `http://localhost:${actualPort}/callback`,
            client_id: 'kg-cli',
            code_verifier: verifier,
          }),
        });

        if (!tokenResponse.ok) {
          const err = await tokenResponse.text();
          throw new Error(`Token exchange failed: ${err}`);
        }

        const tokens = await tokenResponse.json();

        // Store credentials
        await mkdir(dirname(CREDENTIALS_PATH), { recursive: true });
        await writeFile(
          CREDENTIALS_PATH,
          JSON.stringify(
            {
              access_token: tokens.access_token,
              access_token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
              user_email: tokens.user?.email || 'unknown',
              tenantId: tokens.tenantId,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );

        // Store refresh token in keychain
        await keytar.setPassword(KEYCHAIN_SERVICE, 'refresh_token', tokens.refresh_token);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body style="font-family: system-ui; text-align: center; padding: 50px;">
              <h1>Successfully authenticated!</h1>
              <p>You can close this window and return to the terminal.</p>
            </body>
          </html>
        `);

        console.log('\nAuthenticated successfully!');
        console.log(`Logged in as: ${tokens.user?.email || 'unknown'}`);
        console.log(`Tenant: ${tokens.tenantId}`);

        clearTimeout(timeoutId);
        server.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500);
        res.end(`Error: ${message}`);
        console.error('Authentication failed:', message);
        clearTimeout(timeoutId);
        server.close();
        reject(err);
      }
    });

    server.listen(0, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

  // Build authorization URL
  const authUrl = new URL(`${issuer}/oauth/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', 'kg-cli');
  authUrl.searchParams.set('redirect_uri', `http://localhost:${port}/callback`);
  authUrl.searchParams.set('scope', 'kg:read kg:write');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  console.log('Opening browser for authentication...');
  console.log(`If browser doesn't open, visit: ${authUrl.toString()}`);

  await open(authUrl.toString());
}

async function logout() {
  try {
    await unlink(CREDENTIALS_PATH);
  } catch {
    // File may not exist
  }

  await keytar.deletePassword(KEYCHAIN_SERVICE, 'refresh_token');

  console.log('Logged out successfully.');
}

async function status() {
  try {
    const content = await readFile(CREDENTIALS_PATH, 'utf-8');
    const creds = JSON.parse(content);

    const expiresAt = new Date(creds.access_token_expires_at);
    const isExpired = expiresAt < new Date();

    console.log(`Logged in as: ${creds.user_email}`);
    console.log(`Tenant: ${creds.tenantId}`);
    console.log(`Token expires: ${expiresAt.toISOString()} ${isExpired ? '(EXPIRED)' : ''}`);
  } catch {
    console.log('Not logged in. Run `kg auth login` to authenticate.');
  }
}

// CLI entrypoint
const command = process.argv[2];

switch (command) {
  case 'login':
    login().catch(console.error);
    break;
  case 'logout':
    logout().catch(console.error);
    break;
  case 'status':
    status().catch(console.error);
    break;
  default:
    console.log('Usage: kg auth <login|logout|status>');
}
