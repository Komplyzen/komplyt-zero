import { describe, it, expect } from 'vitest';
import { parseLimitArg } from './reembed-work-list.js';

describe('parseLimitArg (reembed --limit)', () => {
  it('no --limit means no limit (undefined)', () => {
    expect(parseLimitArg([])).toBeUndefined();
    expect(parseLimitArg(['--dry-run'])).toBeUndefined();
  });

  it('accepts a positive integer', () => {
    expect(parseLimitArg(['--limit', '10'])).toBe(10);
    expect(parseLimitArg(['--dry-run', '--limit', '1'])).toBe(1);
  });

  it('rejects a missing value', () => {
    expect(() => parseLimitArg(['--limit'])).toThrow("--limit needs a positive integer (got no value)");
  });

  it.each(['0', '-5', 'abc', '1.5', '10x', '', '--dry-run'])('rejects %j', (value) => {
    expect(() => parseLimitArg(['--limit', value])).toThrow(/--limit needs a positive integer/);
  });
});
