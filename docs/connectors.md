# Connecting to the hosted Zero

The hosted service runs this engine at `https://kg.kompl.yt/mcp` as a remote MCP server (Streamable HTTP) with OAuth 2.1. Clients register themselves through Dynamic Client Registration, so there is nothing to configure in advance; you sign in with a Komplyt account when the client asks you to. Data is stored in Frankfurt. To connect a client to a server you run yourself, see [self-hosting.md](self-hosting.md) instead.

## Claude (claude.ai and the desktop app)

1. Open **Settings → Connectors → Add custom connector**.
2. Enter `https://kg.kompl.yt/mcp` as the URL and leave the OAuth client ID and secret empty.
3. Click **Add**, then **Connect**, and sign in with your Komplyt account.
4. In a chat, enable the connector from the tools menu.

If Komplyt Zero is listed in Claude's connector directory for your account, installing it from there does the same thing.

## Claude Code

```bash
claude mcp add --transport http komplyt-zero https://kg.kompl.yt/mcp
```

Then run `/mcp` inside Claude Code and choose the server to sign in. [examples/claude-code](../examples/claude-code) has agent instructions and a session-close skill to go with it.

## ChatGPT

Custom MCP connectors in ChatGPT require developer mode (Settings → Apps & Connectors → Advanced settings → Developer mode), which is available on paid plans.

1. Open **Settings → Apps & Connectors → Create**.
2. Enter `https://kg.kompl.yt/mcp` as the URL and choose **OAuth** as the authentication method.
3. Sign in with your Komplyt account when ChatGPT redirects you.
4. In a chat, enable the connector from the tools menu.

ChatGPT's deep research mode only uses connectors that provide `search` and `fetch` tools, so Zero works in regular chats, not in deep research.

## Other clients

Any client that supports remote MCP servers with OAuth can connect the same way, including Cursor and Mistral Le Chat. Clients without OAuth support cannot connect to the hosted service yet.

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /mcp` | MCP JSON-RPC (`initialize`, `tools/list`, `tools/call`, `ping`) |
| `GET /.well-known/oauth-protected-resource` | Tells clients which authorization server to use |
| `GET /.well-known/oauth-authorization-server` | Authorization server metadata |
| `GET /api/v1/openapi.json` | OpenAPI description of the REST API |
| `GET /health`, `GET /ready` | Liveness and readiness |

To check that the endpoint is reachable and asks for authentication:

```bash
# Expect 401 with a WWW-Authenticate header pointing at the discovery document
curl -i -X POST https://kg.kompl.yt/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

curl -s https://kg.kompl.yt/.well-known/oauth-authorization-server | jq
```
