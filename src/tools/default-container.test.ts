import { describe, it, expect, vi } from 'vitest';
import type { KgDbClient } from '../contracts.js';
import { DefaultContainerDeletedError, ensureDefaultContainer } from './default-container.js';

/** A scripted client: each queryOne call takes the next scripted outcome (a value or an Error). */
function scripted(...outcomes: Array<unknown | Error>): KgDbClient & { calls: string[] } {
  const calls: string[] = [];
  const queue = [...outcomes];
  return {
    calls,
    query: async () => [],
    queryOne: vi.fn(async (sql: string) => {
      calls.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return (next ?? null) as never;
    }),
    close: async () => {},
  } as unknown as KgDbClient & { calls: string[] };
}

describe('ensureDefaultContainer error handling', () => {
  it('returns the existing live container without creating anything', async () => {
    const db = scripted({ id: 'container:t_default' });
    expect(await ensureDefaultContainer(db, 't')).toBe('t_default');
    expect(db.calls).toEqual(['SELECT id']);
  });

  it('a lost creation race (record already exists) uses the winner', async () => {
    const db = scripted(null, new Error('Database record `container:t_default` already exists'), {
      id: 'container:t_default',
    });
    expect(await ensureDefaultContainer(db, 't')).toBe('t_default');
  });

  it('a transaction conflict (what a real concurrent first write produces) is a lost race too', async () => {
    const db = scripted(
      null,
      new Error(
        'Transaction conflict: Write conflict, retry the transaction. This transaction can be retried'
      ),
      { id: 'container:t_default' }
    );
    expect(await ensureDefaultContainer(db, 't')).toBe('t_default');
  });

  it('after a conflict with no winner visible yet, the create is retried', async () => {
    // initial lookup, CREATE conflicts, winner lookup (none yet), deleted? (no), CREATE ok, read back
    const db = scripted(null, new Error('This transaction can be retried'), null, null, null, {
      id: 'container:t_default',
    });
    expect(await ensureDefaultContainer(db, 't')).toBe('t_default');
    expect(db.calls.filter((c) => c.startsWith('CREATE'))).toHaveLength(2);
  });

  it('gives up after a few conflicts instead of looping', async () => {
    const c = () => new Error('This transaction can be retried');
    // initial lookup, then three rounds of: CREATE conflicts, winner lookup (none), deleted? (no)
    const db = scripted(null, c(), null, null, c(), null, null, c(), null, null);
    await expect(ensureDefaultContainer(db, 't')).rejects.toThrow('can be retried');
    expect(db.calls.filter((x) => x.startsWith('CREATE'))).toHaveLength(3);
  });

  it('any other creation error is rethrown, not swallowed into a re-read', async () => {
    const db = scripted(null, new Error('connection reset by peer'));
    await expect(ensureDefaultContainer(db, 't')).rejects.toThrow('connection reset by peer');
    expect(db.calls).toEqual(['SELECT id', "CREATE type::record('container',"]);
  });

  it('a default container that was deleted is reported as such, never reused or silently replaced', async () => {
    // live lookup finds nothing; the fixed id is held by a soft-deleted row
    const db = scripted(null, new Error('Database record `container:t_default` already exists'), null, {
      id: 'container:t_default',
      deleted_at: '2026-10-01T00:00:00Z',
    });
    await expect(ensureDefaultContainer(db, 't')).rejects.toBeInstanceOf(DefaultContainerDeletedError);
  });
});
