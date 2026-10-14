/**
 * Alternative distance measures for embedding quality analysis.
 * SurrealDB only supports cosine similarity natively, but we can compute
 * other measures client-side for drift detection and quality benchmarks.
 */

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('Vector dimension mismatch');
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('Vector dimension mismatch');
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

export function angularDistance(a: number[], b: number[]): number {
  const cos = cosineSimilarity(a, b);
  return Math.acos(Math.max(-1, Math.min(1, cos))) / Math.PI;
}

/**
 * Poincaré distance in the Poincaré ball model.
 * Better for hierarchical relationships - parent/child nodes are closer
 * in hyperbolic space than siblings at the same level.
 *
 * Formula: d(u,v) = arcosh(1 + 2 * ||u-v||² / ((1-||u||²)(1-||v||²)))
 *
 * Note: Embeddings must be normalized to lie within the unit ball (||x|| < 1).
 * Standard embedding models don't produce hyperbolic embeddings, so this
 * requires either:
 * 1. A hyperbolic embedding model (e.g., Poincaré GloVe)
 * 2. Projecting Euclidean embeddings into the ball (loses some properties)
 */
export function poincareDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('Vector dimension mismatch');

  let normASq = 0, normBSq = 0, diffSq = 0;
  for (let i = 0; i < a.length; i++) {
    normASq += a[i] * a[i];
    normBSq += b[i] * b[i];
    const diff = a[i] - b[i];
    diffSq += diff * diff;
  }

  const denom = (1 - normASq) * (1 - normBSq);
  if (denom <= 0) {
    return Infinity;
  }

  const x = 1 + 2 * diffSq / denom;
  return Math.acosh(Math.max(1, x));
}

/**
 * Project a Euclidean embedding into the Poincaré ball.
 * Uses the exponential map at origin: x_ball = tanh(||x||/2) * x/||x||
 *
 * This is a lossy projection - true hyperbolic embeddings require
 * training with hyperbolic loss functions.
 */
export function projectToPoincareBall(v: number[], epsilon = 1e-5): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);

  if (norm < epsilon) return v.slice();

  const scale = Math.tanh(norm / 2) / norm;
  return v.map(x => x * scale * (1 - epsilon));
}

export interface DistanceMetrics {
  cosine: number;
  euclidean: number;
  angular: number;
  poincare: number;
}

export function computeAllDistances(a: number[], b: number[]): DistanceMetrics {
  const aBall = projectToPoincareBall(a);
  const bBall = projectToPoincareBall(b);

  return {
    cosine: 1 - cosineSimilarity(a, b),
    euclidean: euclideanDistance(a, b),
    angular: angularDistance(a, b),
    poincare: poincareDistance(aBall, bBall),
  };
}

export interface DistanceStats {
  metric: string;
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  samples: number;
}

export function computeDistanceStats(
  pairs: Array<{ a: number[]; b: number[] }>,
  metricFn: (a: number[], b: number[]) => number,
  name: string
): DistanceStats {
  if (pairs.length === 0) {
    return { metric: name, mean: 0, stdDev: 0, min: 0, max: 0, samples: 0 };
  }

  const values = pairs.map(p => metricFn(p.a, p.b)).filter(v => isFinite(v));
  if (values.length === 0) {
    return { metric: name, mean: 0, stdDev: 0, min: 0, max: 0, samples: 0 };
  }

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;

  return {
    metric: name,
    mean,
    stdDev: Math.sqrt(variance),
    min: Math.min(...values),
    max: Math.max(...values),
    samples: values.length,
  };
}
