import { describe, it, expect } from 'vitest';
import {
  calculateLocalComplexity,
  calculateActivationFactor,
  applyActivationBoost,
} from '../activation.js';
import { ACTIVATION } from '../contracts.js';

describe('activation', () => {
  describe('calculateLocalComplexity', () => {
    it('should return 0 for isolated node (n < 2)', () => {
      expect(calculateLocalComplexity(1, 0)).toBe(0);
      expect(calculateLocalComplexity(0, 0)).toBe(0);
    });

    it('should increase with more nodes (log scale)', () => {
      const small = calculateLocalComplexity(5, 2);
      const medium = calculateLocalComplexity(50, 20);
      const large = calculateLocalComplexity(500, 200);

      expect(medium).toBeGreaterThan(small);
      expect(large).toBeGreaterThan(medium);
    });

    it('should increase with edge density', () => {
      const sparse = calculateLocalComplexity(10, 5);
      const dense = calculateLocalComplexity(10, 30);

      expect(dense).toBeGreaterThan(sparse);
    });

    it('should cap at 1.0', () => {
      const result = calculateLocalComplexity(10000, 50000);
      expect(result).toBeLessThanOrEqual(1.0);
    });
  });

  describe('calculateActivationFactor', () => {
    it('should return BASE_FACTOR for isolated nodes', () => {
      const factor = calculateActivationFactor(1, 0);
      expect(factor).toBe(ACTIVATION.BASE_FACTOR);
    });

    it('should increase toward MAX_FACTOR with complexity', () => {
      const isolated = calculateActivationFactor(1, 0);
      const connected = calculateActivationFactor(100, 200);

      expect(connected).toBeGreaterThan(isolated);
      expect(connected).toBeLessThanOrEqual(ACTIVATION.MAX_FACTOR);
    });

    it('should be bounded between BASE_FACTOR and MAX_FACTOR', () => {
      const factor = calculateActivationFactor(1000, 5000);
      expect(factor).toBeGreaterThanOrEqual(ACTIVATION.BASE_FACTOR);
      expect(factor).toBeLessThanOrEqual(ACTIVATION.MAX_FACTOR);
    });
  });

  describe('applyActivationBoost', () => {
    it('should boost low decay scores significantly', () => {
      const boosted = applyActivationBoost(0.3, 10, 5);
      expect(boosted).toBeGreaterThan(0.3);
    });

    it('should cap at CEILING', () => {
      const boosted = applyActivationBoost(0.9, 100, 200);
      expect(boosted).toBeLessThanOrEqual(ACTIVATION.CEILING);
    });

    it('should provide diminishing returns near ceiling', () => {
      const lowStart = applyActivationBoost(0.2, 10, 5);
      const highStart = applyActivationBoost(0.7, 10, 5);

      const lowGain = lowStart - 0.2;
      const highGain = highStart - 0.7;

      expect(lowGain).toBeGreaterThan(highGain);
    });

    it('should match Rust formula: new = current + (ceiling - current) * factor', () => {
      const current = 0.5;
      const nodes = 10;
      const edges = 5;
      const factor = calculateActivationFactor(nodes, edges);
      const expected = Math.min(
        current + (ACTIVATION.CEILING - current) * factor,
        ACTIVATION.CEILING
      );

      const result = applyActivationBoost(current, nodes, edges);
      expect(result).toBeCloseTo(expected, 10);
    });
  });
});
