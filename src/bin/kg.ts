#!/usr/bin/env node

const [command] = process.argv.slice(2);

async function main() {
  switch (command) {
    case 'auth':
      // Hand the rest to the auth CLI, which reads its subcommand from argv[2]: drop "auth"
      // first, or it takes "auth" for its own subcommand and only ever prints its usage.
      process.argv.splice(2, 1);
      await import('./auth.js');
      break;

    case 'mcp':
      // Start MCP stdio server
      await import('./mcp.js');
      break;

    default:
      console.log(`
kg - Knowledge Graph CLI

Usage:
  kg auth login     Authenticate with Komplyt
  kg auth logout    Clear stored credentials
  kg auth status    Show current authentication status
  kg mcp            Start MCP stdio server (for Claude Code)

Environment:
  KOMPLYT_ISSUER    Komplyt base URL (default: https://komplyt.com)
  KOMPLYT_JWKS_URL  JWKS endpoint for token validation
  KG_AUTH_MODE      "local" skips login and acts as one fixed local user
                    (KG_LOCAL_SUB, KG_LOCAL_TENANT; default "local"); default "komplyt"
`);
  }
}

main().catch(console.error);
