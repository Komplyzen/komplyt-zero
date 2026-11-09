/**
 * .github/workflows/ok-to-test.yml releases the private CI to code from forks and bots, so its
 * permission gate is a security control that CI cannot run. These checks pin what can be pinned
 * statically: the gate comes first, before any secret is used, and its allow-list stays narrow.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const workflow = readFileSync(join(__dirname, '..', '.github', 'workflows', 'ok-to-test.yml'), 'utf8');
const gateStart = workflow.indexOf('- name: Commenter has write access');
const appTokenStart = workflow.indexOf('- name: Generate GitHub App token');

describe('ok-to-test workflow permission gate', () => {
  it('has the gate, and it runs before the GitHub App token is created', () => {
    expect(gateStart).toBeGreaterThan(-1);
    expect(appTokenStart).toBeGreaterThan(-1);
    expect(gateStart).toBeLessThan(appTokenStart);
  });

  const gate = workflow.slice(gateStart, appTokenStart);

  it('reads the commenter, not the PR author, and uses no App token or secret', () => {
    expect(gate).toContain('context.payload.comment.user.login');
    expect(gate).not.toContain('app-token');
    expect(gate).not.toContain('secrets.');
  });

  it('allows only admin and write, and fails the job otherwise', () => {
    expect(gate).toContain("['admin', 'write']");
    expect(gate).not.toMatch(/'read'|'triage'|'none'/);
    expect(gate).toContain('core.setFailed');
  });
});
