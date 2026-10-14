import { describe, it, expect } from 'vitest';
import { checkTimeout, truncateNeighbors, QUERY_TIMEOUT_MS, selectActiveNodesForHop } from './query.js';

describe('selectActiveNodesForHop', () => {
  const THRESHOLD = 0.1;
  const CAP = 3;

  function makeActivation(scores: Record<string, number>): Map<string, number> {
    return new Map(Object.entries(scores));
  }

  it('hop 0: returns every candidate above threshold, unfiltered and uncapped', () => {
    const activation = makeActivation({ a: 0.9, b: 0.8, c: 0.7, d: 0.6, e: 0.05 });
    const result = selectActiveNodesForHop(activation, THRESHOLD, new Map(), 0, CAP);

    expect(result.sort()).toEqual(['a', 'b', 'c', 'd']); // e excluded (below threshold), rest all included despite exceeding CAP
  });

  it('hop 1+: caps to exactly the top-N by score', () => {
    const activation = makeActivation({ a: 0.9, b: 0.8, c: 0.7, d: 0.6, e: 0.5 });
    const result = selectActiveNodesForHop(activation, THRESHOLD, new Map(), 1, CAP);

    expect(result).toHaveLength(CAP);
    expect(result).toEqual(['a', 'b', 'c']); // exactly the 3 highest, in score order
  });

  it('hop 1+: tie-break is deterministic (strict id order), not dependent on Map iteration order', () => {
    const activation = makeActivation({ z: 0.5, a: 0.5, m: 0.5 });
    const result = selectActiveNodesForHop(activation, THRESHOLD, new Map(), 1, CAP);

    expect(result).toEqual(['a', 'm', 'z']); // all tied at 0.5, strict ascending id order
  });

  it('hop 1+: excludes an already-expanded node whose score has not changed since', () => {
    const activation = makeActivation({ seed: 0.9, fresh1: 0.5, fresh2: 0.4 });
    const expandedAtScore = new Map([['seed', 0.9]]); // seed was expanded at hop 0 with this exact score
    const result = selectActiveNodesForHop(activation, THRESHOLD, expandedAtScore, 1, CAP);

    expect(result).toEqual(['fresh1', 'fresh2']); // seed excluded - re-querying it would find nothing new
  });

  it('hop 1+: re-includes an already-expanded node whose score has since improved', () => {
    const activation = makeActivation({ seed: 0.95, fresh1: 0.5 });
    const expandedAtScore = new Map([['seed', 0.6]]); // seed's score improved (0.6 -> 0.95) via a stronger path found later
    const result = selectActiveNodesForHop(activation, THRESHOLD, expandedAtScore, 1, CAP);

    expect(result).toEqual(['seed', 'fresh1']); // seed re-included and ranked first - re-querying it can now propagate the higher score
  });

  it('hop 1+: an empty candidate set (all below threshold or all already-expanded-unchanged) returns empty, not an error', () => {
    const activation = makeActivation({ a: 0.05 });
    expect(selectActiveNodesForHop(activation, THRESHOLD, new Map(), 1, CAP)).toEqual([]);

    const activation2 = makeActivation({ a: 0.9 });
    expect(selectActiveNodesForHop(activation2, THRESHOLD, new Map([['a', 0.9]]), 1, CAP)).toEqual([]);
  });
});

describe('Query Topology Helpers', () => {
  describe('truncateNeighbors', () => {
    it('passes through when under size limit', () => {
      const nodes = [
        { id: 'node:1', neighbors: [{ id: 'node:2', direction: 'out', weight: 0.5, type: 'explicit' }] },
      ];

      const result = truncateNeighbors(nodes, 50000);
      expect(result.truncated).toBe(false);
      expect(result.nodes[0].neighbors).toHaveLength(1);
    });

    it('reduces neighbors when over limit', () => {
      const manyNeighbors = Array.from({ length: 50 }, (_, i) => ({
        id: `node:${i}`,
        direction: 'out' as const,
        weight: 0.5,
        type: 'explicit',
      }));
      const nodes = Array.from({ length: 100 }, (_, i) => ({
        id: `node:main_${i}`,
        content: 'x'.repeat(200),
        neighbors: [...manyNeighbors],
      }));

      const result = truncateNeighbors(nodes, 50000);
      expect(result.truncated).toBe(true);
    });
  });

  describe('checkTimeout', () => {
    it('returns false when under timeout', () => {
      const startTime = Date.now();
      expect(checkTimeout(startTime)).toBe(false);
    });

    it('returns true when over timeout', () => {
      const startTime = Date.now() - QUERY_TIMEOUT_MS - 50;
      expect(checkTimeout(startTime)).toBe(true);
    });
  });
});

describe('Query Parameters Schema', () => {
  it('includes topology params with defaults', async () => {
    const { queryParamsSchema } = await import('../contracts.js');

    const parsed = queryParamsSchema.parse({});

    expect(parsed.include_edges).toBe(true);
    expect(parsed.include_neighbors).toBe(true);
    expect(parsed.neighbors_limit).toBe(10);
  });

  it('validates neighbors_limit max', async () => {
    const { queryParamsSchema } = await import('../contracts.js');

    expect(() => queryParamsSchema.parse({ neighbors_limit: 100 })).toThrow();
    expect(() => queryParamsSchema.parse({ neighbors_limit: 50 })).not.toThrow();
  });

  it('allows disabling topology', async () => {
    const { queryParamsSchema } = await import('../contracts.js');

    const parsed = queryParamsSchema.parse({
      include_edges: false,
      include_neighbors: false,
    });

    expect(parsed.include_edges).toBe(false);
    expect(parsed.include_neighbors).toBe(false);
  });
});

describe('Response Schemas', () => {
  it('nodeResponseSchema includes neighbors', async () => {
    const { nodeResponseSchema } = await import('../contracts.js');

    const node = nodeResponseSchema.parse({
      id: 'node:123',
      type: 'observation',
      content: 'test',
      neighbors: [
        { id: 'node:456', direction: 'out', weight: 0.8, type: 'explicit' },
      ],
    });

    expect(node.neighbors).toHaveLength(1);
    expect(node.neighbors![0].direction).toBe('out');
  });

  it('activatedNodeResponseSchema includes activation_path', async () => {
    const { activatedNodeResponseSchema } = await import('../contracts.js');

    const node = activatedNodeResponseSchema.parse({
      id: 'node:123',
      type: 'decision',
      content: 'test',
      activation: 0.75,
      activation_source: 'spread',
      activation_path: ['node:seed', 'node:123'],
    });

    expect(node.activation_path).toEqual(['node:seed', 'node:123']);
  });

  it('queryResponseSchema includes edges and flags', async () => {
    const { queryResponseSchema } = await import('../contracts.js');

    const response = queryResponseSchema.parse({
      nodes: [],
      count: 0,
      edges: [{ from: 'node:1', to: 'node:2', direction: 'out', weight: 0.5, type: 'explicit' }],
      timeout: true,
      truncated: false,
      hint: 'test hint',
    });

    expect(response.edges).toHaveLength(1);
    expect(response.timeout).toBe(true);
    expect(response.hint).toBe('test hint');
  });
});

describe('CAP-4: Actionable Timeout Messaging', () => {
  it('timeout hint includes actionable suggestions', async () => {
    const { queryResponseSchema } = await import('../contracts.js');

    const searchTimeoutHint = 'Query timed out. To reduce cost: set spread=false, or reduce limit.';
    const spreadTimeoutHint = 'Query timed out. To reduce cost: set spread_hops=1, or include_edges=false, or include_neighbors=false, or reduce limit.';
    const topologyTimeoutHint = 'Query timed out. To reduce cost: set include_edges=false, or include_neighbors=false.';

    expect(searchTimeoutHint).toContain('spread=false');
    expect(searchTimeoutHint).toContain('reduce limit');

    expect(spreadTimeoutHint).toContain('spread_hops=1');
    expect(spreadTimeoutHint).toContain('include_edges=false');
    expect(spreadTimeoutHint).toContain('include_neighbors=false');

    expect(topologyTimeoutHint).toContain('include_edges=false');
    expect(topologyTimeoutHint).toContain('include_neighbors=false');

    const response = queryResponseSchema.parse({
      nodes: [],
      count: 0,
      timeout: true,
      hint: searchTimeoutHint,
    });
    expect(response.hint).not.toContain('timeout_context');
  });
});

describe('CAP-1: Extended Query Budget', () => {
  it('timeout is 15 seconds (extended from 5s)', () => {
    expect(QUERY_TIMEOUT_MS).toBe(15000);
  });
});
