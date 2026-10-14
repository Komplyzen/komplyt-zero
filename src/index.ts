import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { childLogger } from './logger.js';
import {
  checkTenantTierTable,
  createRootTierWriter,
  createTenantTierRecorder,
  installTenantTierRecorder,
} from './tenant-tier.js';
import { env } from './env.js';
import { ErrorCode, type KgTokenPayload } from './contracts.js';
import { recordRequest, recordDuration, recordSessionPrune, recordSessionPruneFailure, createMetricsRoute } from './metrics.js';
import { createOpenApiRoutes } from './openapi.js';
import { createMcpRoutes } from './mcp.js';
import { createErrorHandler } from './http-errors.js';
import { createRootConnection } from './db.js';
import { publishSigninSecret } from './signin-secret.js';
import { startSessionPruner } from './session-prune.js';
import { bearerGuard } from './secret-guard.js';
import { loadEnterpriseModules } from './ee-loader.js';
import { logLocalModeWarning } from './auth-local.js';
import { resolveCorsOrigin } from './cors-origin.js';
import { checkLocalRequest, isLoopbackBind } from './local-guard.js';
import { pooledDbFactory, gracefulShutdown, getPoolMetrics } from './pool.js';
import { createProviderFromEnv } from './embed.js';
import { toolRegistry } from './tools/index.js';

const logger = childLogger('http');

// Enterprise features (ee/): absent in the open-source edition. Any other
// load failure is fatal (see ee-loader.ts); KG_REQUIRE_EE makes absence fatal too.
// The import must stay a literal (the production bundle follows it), so the open-source tree,
// which has no src/ee/, would fail to typecheck on it: ignore TS2307 here. With ee/ present this
// suppresses nothing and the module keeps its real types.
// (The stricter expect-error form would fail the build whenever ee/ IS present, hence this exception.)
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore TS2307 when src/ee/ is absent
const ee = await loadEnterpriseModules(() => import('./ee/index.js'), env.KG_REQUIRE_EE);
const createOAuthRoutes = ee?.createOAuthRoutes;
const createAdminRoutes = ee?.createAdminRoutes;
const createContainerRoutes = ee?.createContainerRoutes;
logLocalModeWarning();
logger.info(ee ? 'Enterprise features (ee/) loaded' : 'Enterprise features (ee/) not available - running open-source edition');

// claims is set by the MCP route once the bearer token validates, so the
// request log line can carry the caller's identity. Unauthenticated and
// non-MCP requests leave it undefined.
type AppEnv = { Variables: { requestId: string; abortSignal?: AbortSignal; claims?: KgTokenPayload } };

const app = new Hono<AppEnv>();

// Request ID middleware — use Cloud Trace header if present
app.use('*', async (c, next) => {
  const requestId =
    c.req.header('X-Cloud-Trace-Context')?.split('/')[0] || crypto.randomUUID();
  c.set('requestId', requestId);
  c.res.headers.set('X-Request-Id', requestId);
  await next();
});

// Local auth mode has no token, so a page open in the user's browser must not be able to drive it.
if (env.KG_AUTH_MODE === 'local') {
  const guardConfig = {
    allowedOrigins: resolveCorsOrigin(env),
    allowedHosts: env.KG_LOCAL_ALLOWED_HOSTS ?? [],
  };
  app.use('*', async (c, next) => {
    const rejection = checkLocalRequest(
      {
        method: c.req.method,
        contentType: c.req.header('Content-Type'),
        origin: c.req.header('Origin'),
        host: c.req.header('Host'),
      },
      guardConfig
    );
    return rejection ? c.json({ error: rejection.message }, rejection.status) : next();
  });
}

// CORS
app.use(
  '*',
  cors({
    origin: resolveCorsOrigin(env),
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'Mcp-Session-Id'],
  }),
);

// Request timeout (30s) and metrics
// Skip timeout for health/ready/metrics endpoints - they don't acquire DB sessions
const REQUEST_TIMEOUT_MS = 30_000;
// /admin/purge is exempt: it's a secret-gated machine call whose purge run
// can legitimately exceed 30s (sequential per-container transactions). Its
// effective ceiling is the Cloud Run request timeout + the caller's
// --max-time in purge-containers.yml, not this middleware.
const SKIP_TIMEOUT_PATHS = new Set(['/health', '/metrics', '/pool-metrics', '/admin/purge']);

// Machine-polled endpoints. A successful check is noise — Better Stack probes
// /ready from three nodes, so it lands ~every 30s — but a FAILING one is the
// signal we want, so only 2xx/3xx is demoted to debug. /ready still runs the
// full middleware (timeout, DB round trip); this only changes its log level.
const POLLED_PATHS = new Set(['/ready']);

app.use('*', async (c, next) => {
  const start = Date.now();
  const path = new URL(c.req.url).pathname;

  // Fast path for health checks - no timeout, no abort controller
  if (SKIP_TIMEOUT_PATHS.has(path)) {
    await next();
    const duration = Date.now() - start;
    recordRequest(c.req.method, path, c.res.status);
    recordDuration('http', duration);
    // debug: uptime monitors poll these constantly and would drown the log
    logger.debug(
      { method: c.req.method, path, status: c.res.status, duration },
      'Request completed',
    );
    return;
  }

  const abortController = new AbortController();
  c.set('abortSignal', abortController.signal);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      abortController.abort();
      reject(new Error('Request timeout'));
    }, REQUEST_TIMEOUT_MS);
  });

  try {
    await Promise.race([next(), timeoutPromise]);
  } catch (err) {
    if (err instanceof Error && err.message === 'Request timeout') {
      return c.json({ error: { code: ErrorCode.INTERNAL, message: 'Request timeout' } }, 504);
    }
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    const duration = Date.now() - start;
    const status = c.res.status;
    recordRequest(c.req.method, path, status);
    recordDuration('http', duration);
    const level =
      status >= 500
        ? 'error'
        : status >= 400
          ? 'warn'
          : POLLED_PATHS.has(path)
            ? 'debug'
            : 'info';
    const claims = c.get('claims');
    logger[level](
      {
        method: c.req.method,
        path,
        status,
        duration,
        requestId: c.get('requestId'),
        sub: claims?.sub,
        tenantId: claims?.tenantId,
      },
      'Request completed',
    );
  }
});

// Global error handler (see http-errors.ts)
app.onError(createErrorHandler(logger));

// Static assets (icon, docs)
app.get('/icon.png', async (c) => {
  const file = Bun.file(new URL('./public/icon.png', import.meta.url).pathname);
  if (await file.exists()) {
    return new Response(file, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
  }
  return c.text('Not Found', 404);
});

app.get('/docs', async (c) => {
  const file = Bun.file(new URL('./public/docs.html', import.meta.url).pathname);
  if (await file.exists()) {
    return new Response(file, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  return c.text('Not Found', 404);
});

// Health endpoint (no auth)
app.get('/health', (c) =>
  c.json({
    status: 'ok',
    region: process.env.CLOUD_RUN_REGION || 'unknown',
  }),
);

// Readiness endpoint (no auth) — checks DB connection via pool
app.get('/ready', async (c) => {
  try {
    const abortSignal = c.get('abortSignal');
    const db = await pooledDbFactory.createScoped({
      sub: 'health-check',
      tenantId: 'system',
      projects: [],
      scope: 'kg:read',
      principals: ['principal:user_health-check'],
      tier: 'free',
    }, abortSignal);
    await db.query('RETURN 1');
    await (db.release ? db.release() : db.close());
    return c.json({ status: 'ready' });
  } catch (err) {
    logger.error({ err }, 'Readiness check failed');
    return c.json({ status: 'not_ready', error: 'database unavailable' }, 503);
  }
});

// pino's destination is asynchronous: exiting straight after a log call can
// drop the very line that explains the exit. Flush first, with a hard cap.
function flushAndExit(code: number): void {
  setTimeout(() => process.exit(code), 1_000).unref();
  logger.flush(() => process.exit(code));
}

// Graceful shutdown. Registered before the embedding probe and the publish so
// a SIGTERM during either boot retry window is honoured instead of waiting
// out the retries.
// `let` because the SIGTERM handler below reads it before Bun.serve assigns it
// (a const would hit the TDZ).
let server: ReturnType<typeof Bun.serve> | undefined = undefined;
let stopSessionPruner: (() => Promise<void>) | undefined;
let shuttingDown = false;
const isShuttingDown = () => shuttingDown;
process.on('SIGTERM', async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('SIGTERM received, starting graceful shutdown');
  server?.stop();
  await stopSessionPruner?.();
  await gracefulShutdown();
  logger.info('Graceful shutdown complete');
  // Still inside a boot retry window (embedding probe, publish): pending retry
  // timers would keep the process alive.
  if (!server) flushAndExit(0);
});

// Routes mounted with real implementations.
// The provider must produce vectors the index can hold (cohere/fixture: static
// check; ollama: one probe embedding, retried while the server starts). A
// mismatch or failed probe stops the process before it publishes or serves,
// so the previous revision keeps serving.
const embed = await createProviderFromEnv(env).catch((err: unknown) => {
  logger.fatal({ err }, 'Embedding provider check failed; refusing to start');
  flushAndExit(1);
  // Park until the flush-then-exit fires; falling through would start serving.
  return new Promise<never>(() => {});
});

// OAuth discovery endpoints (ee/ only, no auth required)
if (createOAuthRoutes) {
  app.route('/.well-known', createOAuthRoutes());
}

// Connection pooling: WebSocket reused, fresh session per request
app.route('/api/v1', createOpenApiRoutes({ dbFactory: pooledDbFactory, embed, toolRegistry }));
if (createContainerRoutes) {
  app.route('/api/v1/containers', createContainerRoutes({ dbFactory: pooledDbFactory }));
}
// Privileged surface: purge job (service secret) + staff soft-delete (platformRole admin).
// Root connection stays server-internal — callers never hold DB credentials.
if (createAdminRoutes) {
  app.route('/admin', createAdminRoutes({ createRootConnection, purgeJobSecret: env.PURGE_JOB_SECRET }));
}
app.route('/mcp', createMcpRoutes({ dbFactory: pooledDbFactory, embed, toolRegistry }));
// Operational endpoints: closed when METRICS_TOKEN is set, open otherwise (unchanged default).
const metricsGuard = bearerGuard(env.METRICS_TOKEN);
app.use('/metrics', metricsGuard);
app.use('/pool-metrics', metricsGuard);
app.route('/metrics', createMetricsRoute());

// Pool metrics endpoint (before server start)
app.get('/pool-metrics', (c) => {
  const metrics = getPoolMetrics();
  return c.json(metrics);
});

// Server startup
function parseListenAddr(addr: string): { host: string; port: number } {
  const [host, portStr] = addr.split(':');
  return { host: host || '0.0.0.0', port: parseInt(portStr || '3000', 10) };
}

// Local mode serves an unauthenticated API: bind to loopback unless the operator says otherwise.
const listenAddr =
  env.KG_AUTH_MODE === 'local' && !process.env.LISTEN_ADDR ? '127.0.0.1:3000' : env.LISTEN_ADDR;
const { host, port } = parseListenAddr(listenAddr);
if (env.KG_AUTH_MODE === 'local' && !isLoopbackBind(host)) {
  logger.warn(
    { addr: listenAddr },
    'local auth mode is listening on a non-loopback address: anyone who can reach it is the local user. Publish the port on 127.0.0.1 only (docker -p 127.0.0.1:3000:3000).'
  );
}

// Publish this server's signin-secret hash before accepting traffic: the
// kg_server SIGNIN enforces the allowlist, so a server whose hash is missing cannot
// sign in. Any failure (rejected hash, retries exhausted) stops the process so
// the previous revision keeps serving.
try {
  await publishSigninSecret();
} catch (err) {
  logger.fatal({ err }, 'Cannot publish signin secret hash; refusing to start');
  flushAndExit(1);
  // Park until the flush-then-exit fires; falling through would start serving.
  await new Promise<never>(() => {});
}

// Note each tenant's tier (highest seen per hour, off the request path) so the private batch job can
// limit itself to licensed workspaces. Fed only by token verification, so local auth mode, which never
// verifies a token, has nothing to record and does not set it up (no root connection, no boot check).
// The recorder is installed even if migration 037 is not applied yet (it starts working as soon as it
// is), but that is logged loudly at boot rather than failing quietly.
if (env.KG_AUTH_MODE !== 'local') {
  installTenantTierRecorder(createTenantTierRecorder(createRootTierWriter(createRootConnection), { ttlMs: 60 * 60 * 1000 }));
  void checkTenantTierTable(createRootConnection);
}

// SIGTERM landed while publish was finishing: the handler is already tearing
// down, so do not start a server it will never stop.
if (isShuttingDown()) {
  flushAndExit(0);
  await new Promise<never>(() => {});
}

server = Bun.serve({
  hostname: host,
  port,
  fetch: app.fetch,
});

// Once serving: signin rows from scoped requests accumulate otherwise.
if (env.KG_SESSION_PRUNE) {
  stopSessionPruner = startSessionPruner({
    connect: createRootConnection,
    maxAgeMs: env.KG_SESSION_RETENTION_HOURS * 60 * 60 * 1000,
    intervalMs: env.KG_SESSION_PRUNE_INTERVAL_MINUTES * 60 * 1000,
    onRun: (r) => recordSessionPrune(r.removed, r.remaining),
    onFailure: recordSessionPruneFailure,
  });
}

logger.info({ addr: listenAddr }, 'Server started');

export { app };
