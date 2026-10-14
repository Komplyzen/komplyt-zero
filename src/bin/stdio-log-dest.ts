/**
 * Routes logs to stderr for the stdio MCP server, whose stdout carries JSON-RPC
 * framing — a pino line written there corrupts the protocol stream.
 *
 * logger.ts reads KG_LOG_DESTINATION when it builds the root logger at import
 * time, so this must be evaluated first. ESM evaluates dependencies in import
 * order, which is why bin/mcp.ts imports this module above everything else.
 * Keep it there.
 */

process.env.KG_LOG_DESTINATION ??= 'stderr';
