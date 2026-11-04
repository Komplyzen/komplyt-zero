import { describe, it, expect } from 'vitest';
import { parseListenAddr } from './listen-addr.js';
import { isLoopbackBind } from './local-guard.js';

describe('parseListenAddr', () => {
  it.each([
    ['0.0.0.0:3000', '0.0.0.0', 3000],
    [':3000', '0.0.0.0', 3000],
    ['127.0.0.1:8080', '127.0.0.1', 8080],
    ['[::]:3000', '::', 3000],
    ['[::1]:8080', '::1', 8080],
    ['localhost', 'localhost', 3000],
    ['[::1]', '::1', 3000],
    ['localhost:', 'localhost', 3000],
  ])('%s -> host %s, port %i', (addr, host, port) => {
    expect(parseListenAddr(addr)).toEqual({ host, port });
  });

  it.each(['host:abc', 'host:0', 'host:70000', 'host:-1', 'host:30 00', '[::1]:x'])(
    'rejects the port in %s and names it',
    (addr) => {
      expect(() => parseListenAddr(addr)).toThrow(/Invalid LISTEN_ADDR port: "/);
    },
  );

  it('rejects IPv6 without brackets and tells the user to bracket it', () => {
    expect(() => parseListenAddr('::1:3000')).toThrow(/put IPv6 hosts in brackets, e\.g\. \[::1\]:3000/);
  });

  it('rejects an unclosed bracket and text after the closing bracket', () => {
    expect(() => parseListenAddr('[::1:3000')).toThrow(/missing closing bracket/);
    expect(() => parseListenAddr('[::1]3000')).toThrow(/expected :port/);
  });

  it('keeps the local-mode loopback check working on the parsed host', () => {
    expect(isLoopbackBind(parseListenAddr('[::1]:3000').host)).toBe(true);
    expect(isLoopbackBind(parseListenAddr('[::]:3000').host)).toBe(false);
    expect(isLoopbackBind(parseListenAddr('127.0.0.1:3000').host)).toBe(true);
  });
});
