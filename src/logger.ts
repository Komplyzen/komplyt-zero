/**
 * Single configured pino root logger for the whole process.
 *
 * Every module takes a named child of this logger instead of calling pino()
 * itself. Module-level pino() instances inherit no transport, so their output
 * went to stdout and never reached Better Stack — only the logger that happened
 * to own the transport config did.
 *
 * Destination: pino writes to stdout by default, but the stdio MCP server
 * (bin/mcp.ts) uses stdout for JSON-RPC framing, so log lines there would
 * corrupt the protocol stream. That entrypoint sets KG_LOG_DESTINATION=stderr
 * before importing anything that logs.
 */

import pino from 'pino';

// Read process.env rather than env.ts: this module is imported by every module
// that logs, and routing them all through the Zod env schema would couple them
// to it (and make logging fail whenever validation does).
const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const rawLevel = process.env.LOG_LEVEL;
const level = (LEVELS as readonly string[]).includes(rawLevel ?? '') ? rawLevel! : 'info';
const logtailToken = process.env.LOGTAIL_TOKEN;

const destinationFd = process.env.KG_LOG_DESTINATION === 'stderr' ? 2 : 1;

const baseOptions = {
  level,
  // K_SERVICE/K_REVISION are injected by Cloud Run; they separate the prod and
  // staging streams, which share one Better Stack source.
  base: {
    service: process.env.K_SERVICE || 'kg-server-ts-local',
    revision: process.env.K_REVISION,
  },
};

function createRootLogger(): pino.Logger {
  if (logtailToken) {
    return pino({
      ...baseOptions,
      transport: {
        target: '@logtail/pino',
        options: { sourceToken: logtailToken },
      },
    });
  }

  // pino-pretty is a devDependency: published installs (npx, bun index.ts self-hosters) don't have
  // it, so it is opt-in, never the default.
  if (process.env.NODE_ENV === 'development' || /^(1|true|on|yes)$/i.test(process.env.LOG_PRETTY ?? '')) {
    return pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: { destination: destinationFd },
      },
    });
  }

  return pino(baseOptions, pino.destination({ fd: destinationFd, sync: false }));
}

export const rootLogger = createRootLogger();

/** Named child of the root logger, e.g. childLogger('mcp'). */
export function childLogger(name: string): pino.Logger {
  return rootLogger.child({ name });
}
