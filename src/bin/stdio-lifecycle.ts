/**
 * Tracks the JSON-RPC requests the stdio server has received but not yet answered, so a closing
 * stdin can wait for them (`printf req | kg mcp` must still print its reply).
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

type RequestId = string | number;

export interface InFlight {
  /** Resolves when every received request has been answered, or after timeoutMs. */
  idle(timeoutMs: number): Promise<void>;
}

export function trackInFlight(transport: Transport): InFlight {
  const pending = new Set<RequestId>();
  let waiters: Array<() => void> = [];

  const received = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if ('method' in message && 'id' in message) pending.add(message.id);
    received?.(message, extra);
  };

  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    await send(message, options);
    if (!('method' in message) && 'id' in message && message.id !== undefined) pending.delete(message.id);
    if (pending.size === 0) {
      waiters.forEach((resolve) => resolve());
      waiters = [];
    }
  };

  return {
    idle(timeoutMs) {
      if (pending.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
