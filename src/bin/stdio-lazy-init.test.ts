/**
 * `kg mcp` against a database that is not there. Spawns the real entrypoint: the behaviour under
 * test is the process lifecycle, which a unit test cannot see.
 */
import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';

const entrypoint = fileURLToPath(new URL('./mcp.ts', import.meta.url));

const env = {
  PATH: process.env.PATH,
  KG_AUTH_MODE: 'local',
  KG_DB_URL: 'ws://127.0.0.1:1', // nothing listens here
  KG_DB_USER: 'u',
  KG_DB_PASS: 'p',
  KG_JWT_SECRET: 'placeholder-secret-of-at-least-32-characters',
  EMBEDDING_PROVIDER: 'fixture',
  LOG_LEVEL: 'error',
};

function start() {
  const child = spawn(process.execPath, ['--import', 'tsx', entrypoint], { env, stdio: 'pipe' });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const reply = async () => JSON.parse((await lines.next()).value as string);
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  return { child, send, reply, exited };
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };

function stop(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode === null) child.kill('SIGKILL');
}

describe('kg mcp without a reachable database', () => {
  it('answers initialize and tools/list, then a database tool call fails with the cause', async () => {
    const { child, send, reply } = start();
    try {
      send(initialize);
      const init = await reply();
      expect(init.result.serverInfo).toMatchObject({ name: 'komplyt-zero', title: 'Komplyt Zero' });

      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const list = await reply();
      const query = list.result.tools.find((t: { name: string }) => t.name === 'kg_query');
      expect(query.inputSchema.type).toBe('object');
      const described = Object.values(query.inputSchema.properties as Record<string, { description?: string }>);
      expect(described.length).toBeGreaterThan(0);
      expect(described.every((p) => p.description)).toBe(true);

      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'kg_status', arguments: {} } });
      const call = await reply();
      expect(call.result.isError).toBe(true);
      expect(call.result.content[0].text).toMatch(/could not start|still starting/);
    } finally {
      stop(child);
    }
  }, 40_000);

  it('answers an unknown tool at once, without waiting for startup', async () => {
    const { child, send, reply } = start();
    try {
      send(initialize);
      await reply();
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'kg_nope', arguments: {} } });
      const call = await reply();
      expect(call.result).toMatchObject({ isError: true, content: [{ text: 'Unknown tool: kg_nope' }] });
    } finally {
      stop(child);
    }
  }, 20_000);

  it('replies to what it was sent and exits 0 when stdin closes', async () => {
    const { child, send, reply, exited } = start();
    try {
      send(initialize);
      child.stdin.end();
      expect((await reply()).id).toBe(1);
      expect(await exited).toBe(0);
    } finally {
      stop(child);
    }
  }, 20_000);

  it('exits 0 on SIGTERM while startup is still running', async () => {
    const { child, send, reply, exited } = start();
    try {
      send(initialize);
      await reply();
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
    } finally {
      stop(child);
    }
  }, 20_000);
});
