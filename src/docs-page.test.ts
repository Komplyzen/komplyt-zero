import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { toolRegistry } from './tools/index.js';

// The /docs route (index.ts) serves this file verbatim.
const html = readFileSync(new URL('./public/docs.html', import.meta.url), 'utf8');

describe('public docs page', () => {
  it('is canonical for kg.kompl.yt/docs and indexable', () => {
    expect(html).toContain('<link rel="canonical" href="https://kg.kompl.yt/docs">');
    expect(html).toContain('<meta name="robots" content="index,follow">');
  });

  it('carries TechArticle JSON-LD whose facts are also visible text', () => {
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    const ld = JSON.parse(m![1]);
    expect(ld['@type']).toBe('TechArticle');
    expect(ld.inLanguage).toBe('en');
    expect(ld.url).toBe('https://kg.kompl.yt/docs');
    const visible = html.replace(m![0], '');
    expect(visible).toContain(ld.about.replace('Komplyt ', ''));
    expect(visible).toContain('<h1');
  });

  it('shows the MCP URL and the auth metadata URLs as plain text', () => {
    for (const url of [
      'https://kg.kompl.yt/mcp',
      'https://www.kompl.yt/.well-known/oauth-authorization-server',
      'https://kg.kompl.yt/.well-known/oauth-protected-resource',
    ]) {
      expect(html).toContain(`>${url}<`);
    }
    expect(html).toContain('class="language-bash"');
    expect(html).toContain('class="language-json"');
  });

  it('does not document the removed API-key header auth', () => {
    expect(html).not.toMatch(/X-KG-(User|Org)/i);
  });

  it('documents exactly the registered tools', () => {
    const documented = [...html.matchAll(/<code class="text-zero-accent font-medium">(kg_\w+)<\/code>/g)].map((m) => m[1]);
    const registered = toolRegistry.list().map((t) => t.name);
    expect([...documented].sort()).toEqual([...registered].sort());
  });
});
