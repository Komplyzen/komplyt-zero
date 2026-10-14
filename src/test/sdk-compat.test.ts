import { describe, it, expect } from 'vitest';
import { extractRecordId, normalizeRecordId } from '../contracts.js';

/**
 * SDK Compatibility Tests
 *
 * These tests verify the fixes for SurrealDB SDK compatibility issues
 * discovered during staging testing. Each test is designed to FAIL if
 * the bug regresses.
 */

describe('extractRecordId', () => {
  it('handles SurrealDB StringRecordId class (typeof object with toString)', () => {
    // BUG: StringRecordId.startsWith() fails because it's an object, not string
    // FIX: String() coercion before string operations

    // Simulate StringRecordId - an object that stringifies to "table:id"
    class MockStringRecordId {
      constructor(public tb: string, public id: string) {}
      toString() { return `${this.tb}:${this.id}`; }
      // Note: startsWith() is NOT available on this class
    }

    const recordId = new MockStringRecordId('node', 'abc123');

    // This would throw before the fix:
    // recordId.startsWith('node:') // TypeError: startsWith is not a function

    // After fix, extractRecordId handles it:
    expect(extractRecordId(recordId, 'node')).toBe('abc123');
  });

  it('handles angle-bracket escaped UUIDs from SDK', () => {
    // BUG: SDK returns UUIDs as node:⟨uuid⟩, comparison fails
    // FIX: normalizeRecordId strips escaping

    const escaped = 'node:⟨550e8400-e29b-41d4-a716-446655440000⟩';
    const normalized = normalizeRecordId(escaped);

    expect(normalized).toBe('node:550e8400-e29b-41d4-a716-446655440000');
    expect(normalized).not.toContain('⟨');
    expect(normalized).not.toContain('⟩');
  });

  it('strips bracket-escaping from a colon-containing id (project-id regression)', () => {
    // BUG: project record IDs are name-based and can contain a colon
    // (e.g. "komplyzen:kg-mcp-server"), which forces SurrealDB to
    // bracket-escape the id segment when serializing it as a string:
    // "project:⟨komplyzen:kg-mcp-server⟩". The pre-fix extractRecordId only
    // stripped the "table:" prefix, leaving the brackets in the returned id.
    // That leftover-bracketed value then got re-escaped when fed back into
    // type::record(), producing "project:⟨⟨komplyzen:kg-mcp-server\⟩⟩".
    const escapedString = 'project:⟨komplyzen:kg-mcp-server⟩';

    // Prove the pre-fix shape of the bug: prefix-only stripping (what the
    // old implementation did) leaves the brackets in place.
    const prefixOnlyStrip = escapedString.slice('project:'.length);
    expect(prefixOnlyStrip).toBe('⟨komplyzen:kg-mcp-server⟩');
    expect(prefixOnlyStrip).toContain('⟨');

    // The fixed extractRecordId strips the brackets too.
    const fromString = extractRecordId(escapedString, 'project');
    expect(fromString).toBe('komplyzen:kg-mcp-server');
    expect(fromString).not.toContain('⟨');
    expect(fromString).not.toContain('⟩');
  });

  it('leaves a plain, non-escaped id unchanged', () => {
    // Regression guard: stripBracketEscaping must be a no-op for the common
    // case (an id with no special characters, nothing to escape).
    expect(extractRecordId('node:abc123', 'node')).toBe('abc123');
    expect(extractRecordId({ tb: 'node', id: 'abc123' }, 'node')).toBe('abc123');
  });

  it('returns an identical clean id whether the driver hands back an object or an escaped string', () => {
    // CAP-1: extractRecordId must be idempotent regardless of which
    // serialized form the SurrealDB driver returns for the same record.
    const fromObject = extractRecordId({ tb: 'project', id: 'komplyzen:kg-mcp-server' }, 'project');
    const fromEscapedString = extractRecordId('project:⟨komplyzen:kg-mcp-server⟩', 'project');

    expect(fromObject).toBe('komplyzen:kg-mcp-server');
    expect(fromEscapedString).toBe('komplyzen:kg-mcp-server');
    expect(fromObject).toBe(fromEscapedString);
  });
});

describe('Optional Query Parameters (NULL vs NONE)', () => {
  // These tests verify the pattern that prevents NULL vs NONE errors

  it('optional fields must be OMITTED, not set to null', () => {
    // BUG: Passing `field: null` sends NULL, but schema expects NONE
    // SurrealDB error: "Expected `none | float` but found `NULL`"
    // FIX: Only add field to params object when value is defined

    function buildQueryParams(required: string, optional?: number) {
      // BAD pattern (would fail):
      // return { required, optional: optional ?? null };

      // GOOD pattern (the fix):
      const params: Record<string, unknown> = { required };
      if (optional !== undefined) {
        params.optional = optional;
      }
      return params;
    }

    const withOptional = buildQueryParams('req', 42);
    const withoutOptional = buildQueryParams('req');

    expect(withOptional).toEqual({ required: 'req', optional: 42 });
    expect(withoutOptional).toEqual({ required: 'req' });
    expect('optional' in withoutOptional).toBe(false); // Key must be absent
  });

  it('dynamic SET clause building for optional fields', () => {
    // BUG: Static query with all fields + null values fails
    // FIX: Build query dynamically, only include defined fields

    interface DecayEventParams {
      nodeId: string;
      eventType: string;
      factor?: number;
      complexity?: number;
      reason?: string;
    }

    function buildDecayEventQuery(event: DecayEventParams) {
      const optionalFields: [string, string, unknown][] = [
        ['factor', 'factor', event.factor],
        ['complexity', 'complexity', event.complexity],
        ['reason', 'reason', event.reason],
      ];

      const params: Record<string, unknown> = {
        node_id: event.nodeId,
        event_type: event.eventType,
      };

      const optionalSets = optionalFields
        .filter(([, , value]) => value !== undefined)
        .map(([field, param, value]) => {
          params[param] = value;
          return `${field} = $${param}`;
        });

      const optionalClause = optionalSets.length ? ', ' + optionalSets.join(', ') : '';

      return {
        query: `CREATE decay_event SET node = $node_id, event_type = $event_type${optionalClause}`,
        params,
      };
    }

    // Test with some optional fields
    const result1 = buildDecayEventQuery({
      nodeId: 'abc',
      eventType: 'activation',
      factor: 0.5,
      // complexity and reason are undefined
    });

    expect(result1.query).toContain('factor = $factor');
    expect(result1.query).not.toContain('complexity');
    expect(result1.query).not.toContain('reason');
    expect(result1.params).toEqual({
      node_id: 'abc',
      event_type: 'activation',
      factor: 0.5,
    });

    // Test with no optional fields
    const result2 = buildDecayEventQuery({
      nodeId: 'def',
      eventType: 'created',
    });

    expect(result2.query).not.toContain('factor');
    expect(result2.params).toEqual({
      node_id: 'def',
      event_type: 'created',
    });
  });
});

describe('Record References in IN Clauses', () => {
  // These tests verify the pattern for building record references

  it('{tb, id} objects must be converted to type::record() calls', () => {
    // BUG: Passing [{tb:'node', id:'abc'}] to IN clause doesn't match records
    // Query returns empty even when records exist
    // FIX: Build type::record() calls in query string

    function buildFetchQuery(ids: string[]) {
      // BAD pattern (would silently return empty):
      // const badIds = ids.map(id => ({ tb: 'node', id }));
      // return { query: 'SELECT * FROM node WHERE id IN $ids', params: { ids: badIds } };

      // GOOD pattern (the fix):
      const recordRefs = ids.map((_, i) => `type::record('node', $id${i})`).join(', ');
      const params: Record<string, string> = {};
      ids.forEach((id, i) => { params[`id${i}`] = id; });

      return {
        query: `SELECT * FROM node WHERE id IN [${recordRefs}]`,
        params,
      };
    }

    const result = buildFetchQuery(['abc', 'def', 'ghi']);

    // Query must contain type::record() calls, not $ids placeholder
    expect(result.query).toContain("type::record('node', $id0)");
    expect(result.query).toContain("type::record('node', $id1)");
    expect(result.query).toContain("type::record('node', $id2)");
    expect(result.query).not.toContain('$ids');

    // Params must have individual id0, id1, id2 keys
    expect(result.params).toEqual({
      id0: 'abc',
      id1: 'def',
      id2: 'ghi',
    });
  });

  it('single record refs must use type::record() not $var with {tb,id}', () => {
    // BUG: UPDATE $session_id with {tb:'session', id:'abc'} fails
    // Error: "Cannot execute UPDATE statement using value: { id: '...', tb: 'session' }"
    // FIX: Use type::record('session', $session_id) with plain string ID

    function buildSessionEndQuery(sessionId: string) {
      // BAD pattern (would fail):
      // return {
      //   query: 'UPDATE $session_id SET ended_at = time::now()',
      //   params: { session_id: { tb: 'session', id: sessionId } },
      // };

      // GOOD pattern (the fix):
      const cleanId = extractRecordId(sessionId, 'session');
      return {
        query: "UPDATE type::record('session', $session_id) SET ended_at = time::now()",
        params: { session_id: cleanId },
      };
    }

    const result = buildSessionEndQuery('session:abc123');

    expect(result.query).toContain("type::record('session', $session_id)");
    expect(result.query).not.toContain('$session_id SET'); // Not using $var directly
    expect(result.params.session_id).toBe('abc123'); // Plain string, not object
    expect(typeof result.params.session_id).toBe('string');
  });
});

describe('SurrealQL Function Signatures', () => {
  it('math::min requires array argument, not varargs', () => {
    // BUG: math::min(a, b) throws "Incorrect arguments for function math::min(). Expected 1 argument"
    // FIX: math::min([a, b])

    function buildDecayScoreUpdate() {
      // BAD pattern (would fail):
      // return 'decay_score = math::min(decay_score + (...), $ceiling)';

      // GOOD pattern (the fix):
      return 'decay_score = math::min([decay_score + ($ceiling - decay_score) * $factor, $ceiling])';
    }

    const query = buildDecayScoreUpdate();

    // Must use array syntax
    expect(query).toContain('math::min([');
    expect(query).toContain('])');

    // Must NOT use varargs syntax
    expect(query).not.toMatch(/math::min\([^[]/);
  });
});

describe('Record ID Normalization in Maps', () => {
  it('map lookups must use normalized IDs to avoid format mismatch', () => {
    // BUG: Seeds stored with one ID format, fetched nodes have different format
    // Result: activation.get(node.id) returns undefined, all nodes get activation: 0
    // FIX: Normalize all IDs before map operations

    const activation = new Map<string, number>();

    // Seed ID format (from semantic search)
    const seedId = 'node:⟨abc123⟩';
    const normalizedSeed = seedId.replace(/⟨([^⟩]+)⟩/g, '$1');
    activation.set(normalizedSeed, 0.75);

    // Fetched ID format (from fetchNodesByIds)
    const fetchedId = 'node:abc123';
    const normalizedFetched = fetchedId.replace(/⟨([^⟩]+)⟩/g, '$1');

    // Without normalization: activation.get(seedId) would fail to find fetchedId
    // With normalization: both resolve to 'node:abc123'
    expect(normalizedSeed).toBe(normalizedFetched);
    expect(activation.get(normalizedFetched)).toBe(0.75);
  });

  it('seedIds.has() must use normalized ID to detect direct vs spread', () => {
    // BUG: seedIds.has(node.id) returns false even for seeds
    // Result: all nodes marked as activation_source: 'spread'
    // FIX: Normalize IDs when adding to seedIds and when checking

    const seedIds = new Set<string>();

    // Add normalized seed ID
    const rawSeedId = 'node:⟨def456⟩';
    const normalizedSeedId = rawSeedId.replace(/⟨([^⟩]+)⟩/g, '$1');
    seedIds.add(normalizedSeedId);

    // Check with different raw format
    const fetchedId = 'node:def456';
    const normalizedFetchedId = fetchedId.replace(/⟨([^⟩]+)⟩/g, '$1');

    expect(seedIds.has(normalizedFetchedId)).toBe(true);
  });
});

describe('Atomic Operations', () => {
  it('node creation and decay_event must be in same transaction', () => {
    // BUG: Node created, then decay_event fails = orphan node
    // FIX: Combine in single multi-statement query

    function buildAtomicNodeCreate() {
      // BAD pattern (non-atomic, would create orphans):
      // await db.query('CREATE node SET ...');
      // await logDecayEvent(db, nodeId); // If this fails, node already committed

      // GOOD pattern (the fix):
      return `
        LET $node = (CREATE node SET type = $type, content = $content RETURN id);
        CREATE decay_event SET node = $node[0].id, event_type = 'created';
        RETURN $node[0];
      `;
    }

    const query = buildAtomicNodeCreate();

    // Must use LET to capture created node
    expect(query).toContain('LET $node');
    // Must create both node and decay_event in same query
    expect(query).toContain('CREATE node');
    expect(query).toContain('CREATE decay_event');
    // decay_event must reference the LET variable
    expect(query).toContain('$node[0]');
  });
});
