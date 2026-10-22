import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { buildServerInfo } from './server-info.js';

const { version } = createRequire(import.meta.url)('./package.json') as { version: string };

describe('buildServerInfo', () => {
  it('reports the configured name, the product title and the package.json version', () => {
    expect(buildServerInfo('komplyt-zero')).toMatchObject({ name: 'komplyt-zero', title: 'Komplyt Zero', version });
  });

  it('adds an icon only when a public URL is configured', () => {
    expect(buildServerInfo('x').iconUrl).toBeUndefined();
    expect(buildServerInfo('x', 'https://kg.example').iconUrl).toBe('https://kg.example/icon.png');
  });
});
