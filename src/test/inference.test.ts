import { describe, it, expect, beforeEach } from 'vitest';
import { classifyEdge, resetCentroids, RelationshipType } from '../inference.js';

describe('inference', () => {
  describe('classifyEdge', () => {
    beforeEach(() => {
      resetCentroids();
    });

    it('returns unknown when confidence is below 85%', () => {
      const centroids = new Map<RelationshipType, number[]>([
        ['evolves_to', [1, 0, 0]],
        ['clarifies', [0, 1, 0]],
        ['realizes', [0, 0, 1]],
        ['informs', [0.5, 0.5, 0]],
      ]);

      // Diff vector that doesn't align well with any centroid
      const result = classifyEdge(
        [0, 0, 0],
        [0.3, 0.3, 0.3], // diff = [0.3, 0.3, 0.3] - doesn't strongly align with any
        centroids
      );

      expect(result.type).toBe('unknown');
      expect(result.confidence).toBeLessThan(0.85);
    });

    it('classifies as evolves_to when diff vector aligns with evolves_to centroid', () => {
      const centroids = new Map<RelationshipType, number[]>([
        ['evolves_to', [1, 0, 0]],
        ['clarifies', [0, 1, 0]],
        ['realizes', [0, 0, 1]],
        ['informs', [-1, 0, 0]],
      ]);

      // Diff vector strongly aligns with evolves_to [1, 0, 0]
      const result = classifyEdge(
        [0, 0, 0],
        [1, 0, 0],
        centroids
      );

      expect(result.confidence).toBe(1.0);
      expect(result.type).toBe('evolves_to');
    });

    it('classifies as realizes when diff vector aligns with realizes centroid', () => {
      const centroids = new Map<RelationshipType, number[]>([
        ['evolves_to', [1, 0, 0]],
        ['clarifies', [0, 1, 0]],
        ['realizes', [0, 0, 1]],
        ['informs', [-1, 0, 0]],
      ]);

      const result = classifyEdge(
        [0, 0, 0],
        [0, 0, 1],
        centroids
      );

      expect(result.confidence).toBe(1.0);
      expect(result.type).toBe('realizes');
    });

    it('handles normalized difference vectors', () => {
      const centroids = new Map<RelationshipType, number[]>([
        ['evolves_to', [1, 0, 0]],
        ['clarifies', [0, 1, 0]],
        ['realizes', [0, 0, 1]],
        ['informs', [-1, 0, 0]],
      ]);

      // Larger magnitude but same direction should still classify correctly
      const result = classifyEdge(
        [0, 0, 0],
        [10, 0, 0], // diff = [10, 0, 0], same direction as evolves_to
        centroids
      );

      expect(result.type).toBe('evolves_to');
      expect(result.confidence).toBe(1.0);
    });

    it('returns unknown for zero-length difference vectors', () => {
      const centroids = new Map<RelationshipType, number[]>([
        ['evolves_to', [1, 0, 0]],
        ['clarifies', [0, 1, 0]],
        ['realizes', [0, 0, 1]],
        ['informs', [-1, 0, 0]],
      ]);

      const result = classifyEdge(
        [1, 2, 3],
        [1, 2, 3], // same point, zero diff
        centroids
      );

      expect(result.type).toBe('unknown');
      expect(result.confidence).toBe(0);
    });
  });
});
