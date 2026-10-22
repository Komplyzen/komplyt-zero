import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { trackInFlight } from './stdio-lifecycle.js';

afterEach(() => vi.useRealTimers());

function fakeTransport() {
  const transport = {
    start: async () => {},
    close: async () => {},
    send: vi.fn(async () => {}),
    onmessage: vi.fn(),
  } as unknown as Transport;
  return transport;
}

describe('trackInFlight', () => {
  it('is idle at once when nothing is pending', async () => {
    const inFlight = trackInFlight(fakeTransport());
    await expect(inFlight.idle(10_000)).resolves.toBeUndefined();
  });

  it('forwards received messages to the original handler', () => {
    const transport = fakeTransport();
    const original = transport.onmessage;
    trackInFlight(transport);
    transport.onmessage?.({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(original).toHaveBeenCalledOnce();
  });

  it('waits until the response to a received request has been sent', async () => {
    const transport = fakeTransport();
    const inFlight = trackInFlight(transport);
    transport.onmessage?.({ jsonrpc: '2.0', id: 7, method: 'tools/list' });

    let idle = false;
    const waiting = inFlight.idle(10_000).then(() => (idle = true));
    await Promise.resolve();
    expect(idle).toBe(false);

    await transport.send({ jsonrpc: '2.0', id: 7, result: {} });
    await waiting;
    expect(idle).toBe(true);
  });

  it('does not count notifications', async () => {
    const transport = fakeTransport();
    const inFlight = trackInFlight(transport);
    transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await expect(inFlight.idle(10_000)).resolves.toBeUndefined();
  });

  it('gives up after the timeout when a request is never answered', async () => {
    vi.useFakeTimers();
    const transport = fakeTransport();
    const inFlight = trackInFlight(transport);
    transport.onmessage?.({ jsonrpc: '2.0', id: 1, method: 'tools/call' });

    const waiting = inFlight.idle(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(waiting).resolves.toBeUndefined();
  });
});
