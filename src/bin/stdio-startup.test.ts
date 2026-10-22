import { describe, it, expect, vi, afterEach } from 'vitest';
import { createStartup, StartupFailedError, StartupPendingError } from './stdio-startup.js';

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe('createStartup', () => {
  it('runs once for concurrent callers and returns the same value', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    const startup = createStartup(run);
    startup.begin();
    expect(await Promise.all([startup.ready(), startup.ready()])).toEqual(['ok', 'ok']);
    expect(await startup.ready()).toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('starts on the first ready() when begin() was never called', async () => {
    const run = vi.fn().mockResolvedValue(1);
    expect(await createStartup(run).ready()).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('answers "still starting" after the wait cap while the run continues', async () => {
    vi.useFakeTimers();
    const gate = deferred<string>();
    const run = vi.fn(() => gate.promise);
    const startup = createStartup(run, { waitMs: 10_000 });
    startup.begin();

    const waiting = startup.ready();
    const assertion = expect(waiting).rejects.toBeInstanceOf(StartupPendingError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    gate.resolve('late');
    expect(await startup.ready()).toBe('late');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports the cause and a pointer to the self-hosting docs when startup fails', async () => {
    const startup = createStartup(() => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:8000')));
    startup.begin();
    const error = await startup.ready().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StartupFailedError);
    expect((error as Error).message).toContain('ECONNREFUSED 127.0.0.1:8000');
    expect((error as Error).message).toContain('docs/self-hosting.md');
  });

  it('fails fast with the last error during the cooldown, then retries once', async () => {
    let clock = 1_000;
    const run = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue('up');
    const startup = createStartup(run, { cooldownMs: 30_000, now: () => clock });

    await expect(startup.ready()).rejects.toThrow('down');
    clock += 29_999;
    await expect(startup.ready()).rejects.toThrow('down');
    await expect(startup.ready()).rejects.toThrow('down');
    expect(run).toHaveBeenCalledTimes(1);

    clock += 1;
    const [a, b] = await Promise.all([startup.ready(), startup.ready()]);
    expect([a, b]).toEqual(['up', 'up']);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('begin() does not start a second run during the cooldown or while one is running', async () => {
    const run = vi.fn().mockRejectedValue(new Error('down'));
    const startup = createStartup(run, { cooldownMs: 30_000, now: () => 5 });
    startup.begin();
    await startup.ready().catch(() => {});
    startup.begin();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
