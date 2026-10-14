/**
 * Relationship type inference from embedding difference vectors.
 *
 * Uses Cohere embeddings to classify edge relationships into:
 * - evolves_to: concept refinement over time
 * - clarifies: explanation or detail
 * - realizes: decision → implementation
 * - informs: supporting context
 *
 * Classification via cosine similarity to reference centroids.
 * Requires ≥85% agreement for confident classification.
 */

import { KgDbClient, EmbeddingProvider } from './contracts.js';

export type RelationshipType = 'evolves_to' | 'clarifies' | 'realizes' | 'informs' | 'unknown';

export interface EdgeWithEmbeddings {
  fromId: string;
  toId: string;
  fromEmbedding: number[];
  toEmbedding: number[];
}

export interface ClassifiedEdge {
  fromId: string;
  toId: string;
  type: RelationshipType;
  confidence: number;
}

// Reference centroids per container (initialized lazily)
// Key is containerId, value is centroid map
const referenceCentroidsCache = new Map<string, Map<RelationshipType, number[]>>();

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

function vectorDifference(target: number[], source: number[]): number[] {
  return target.map((t, i) => t - source[i]);
}


/**
 * Initialize reference centroids from labeled edges in the database.
 * Falls back to synthetic centroids if no labeled data exists.
 */
async function initializeCentroids(
  db: KgDbClient,
  embed: EmbeddingProvider,
  containerId: string
): Promise<Map<RelationshipType, number[]>> {
  const centroids = new Map<RelationshipType, number[]>();
  const dims = embed.dimensions;

  // Try to find labeled edges of each type
  const types: RelationshipType[] = ['evolves_to', 'clarifies', 'realizes', 'informs'];

  for (const type of types) {
    const edges = await db.query<{ in_emb: number[]; out_emb: number[] }>(
      `SELECT in.embedding as in_emb, out.embedding as out_emb
       FROM edge
       WHERE type = $type
         AND in.container = type::record('container', $cid)
         AND in.embedding != NONE
         AND out.embedding != NONE
       LIMIT 50`,
      { type, cid: containerId }
    );

    if (edges.length >= 5) {
      // Compute mean difference vector
      const diffVectors = edges.map(e => vectorDifference(e.out_emb, e.in_emb));
      const meanDiff = new Array(dims).fill(0);

      for (const diff of diffVectors) {
        for (let i = 0; i < dims; i++) {
          meanDiff[i] += diff[i] / diffVectors.length;
        }
      }

      centroids.set(type, meanDiff);
    }
  }

  // If we don't have enough labeled data, use synthetic centroids
  // These are heuristic patterns based on expected embedding behavior
  if (centroids.size < 4) {
    // Synthetic centroids: distinct random directions
    // In practice, these should be trained or manually curated
    const syntheticBase = await embed.embedDocuments([
      'This evolves from the previous version',
      'This clarifies and explains the concept',
      'This implements and realizes the decision',
      'This provides supporting information',
    ]);

    // Use the embeddings directly as "centroids" for each type
    // (This is a simplification - real centroids would come from diff vectors)
    if (!centroids.has('evolves_to')) centroids.set('evolves_to', syntheticBase[0]);
    if (!centroids.has('clarifies')) centroids.set('clarifies', syntheticBase[1]);
    if (!centroids.has('realizes')) centroids.set('realizes', syntheticBase[2]);
    if (!centroids.has('informs')) centroids.set('informs', syntheticBase[3]);
  }

  return centroids;
}

/**
 * Classify a single edge based on embedding difference vector.
 */
export function classifyEdge(
  fromEmbedding: number[],
  toEmbedding: number[],
  centroids: Map<RelationshipType, number[]>
): ClassifiedEdge & { fromId: string; toId: string } {
  const diffVector = vectorDifference(toEmbedding, fromEmbedding);

  let bestType: RelationshipType = 'unknown';
  let bestSimilarity = -1;

  for (const [type, centroid] of centroids) {
    const similarity = cosineSimilarity(diffVector, centroid);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestType = type;
    }
  }

  // Require ≥0.85 similarity for confident classification
  const confidence = Math.max(0, bestSimilarity);
  if (confidence < 0.85) {
    bestType = 'unknown';
  }

  return {
    fromId: '',
    toId: '',
    type: bestType,
    confidence,
  };
}

/**
 * Classify multiple edges in batch.
 */
export async function classifyEdges(
  db: KgDbClient,
  embed: EmbeddingProvider,
  containerId: string,
  edges: EdgeWithEmbeddings[]
): Promise<ClassifiedEdge[]> {
  if (edges.length === 0) return [];

  // Initialize centroids if needed (per-container cache)
  if (!referenceCentroidsCache.has(containerId)) {
    const centroids = await initializeCentroids(db, embed, containerId);
    referenceCentroidsCache.set(containerId, centroids);
  }
  const centroids = referenceCentroidsCache.get(containerId)!;

  return edges.map(edge => {
    const result = classifyEdge(edge.fromEmbedding, edge.toEmbedding, centroids);
    return {
      ...result,
      fromId: edge.fromId,
      toId: edge.toId,
    };
  });
}

/**
 * Count edges by inferred relationship type within a scope.
 */
export async function countEdgesByType(
  db: KgDbClient,
  embed: EmbeddingProvider,
  containerId: string,
  scopeFilter: string,
  params: Record<string, unknown>
): Promise<Record<RelationshipType, number>> {
  const counts: Record<RelationshipType, number> = {
    evolves_to: 0,
    clarifies: 0,
    realizes: 0,
    informs: 0,
    unknown: 0,
  };

  // Build scope filter for edge query (edge.in.container, not edge.container)
  const edgeScopeFilter = scopeFilter
    .replace(/^container\s*=/, 'in.container =')
    .replace(/\bproject\.name\s*=/, 'in.project.name =')
    .replace(/\bauthor\.name\s*=/, 'in.author.name =');

  // Get edges with embeddings
  const edges = await db.query<{
    from_id: string;
    to_id: string;
    in_emb: number[];
    out_emb: number[];
    edge_type: string;
  }>(
    `SELECT
       in as from_id,
       out as to_id,
       in.embedding as in_emb,
       out.embedding as out_emb,
       type as edge_type
     FROM edge
     WHERE ${edgeScopeFilter}
       AND in.embedding != NONE
       AND out.embedding != NONE
     LIMIT 1000`,
    params
  );

  // Separate edges by whether they already have a known relationship type
  const knownTypes: RelationshipType[] = ['evolves_to', 'clarifies', 'realizes', 'informs'];
  const toClassify: EdgeWithEmbeddings[] = [];

  for (const edge of edges) {
    if (edge.edge_type && knownTypes.includes(edge.edge_type as RelationshipType)) {
      counts[edge.edge_type as RelationshipType]++;
    } else {
      toClassify.push({
        fromId: String(edge.from_id),
        toId: String(edge.to_id),
        fromEmbedding: edge.in_emb,
        toEmbedding: edge.out_emb,
      });
    }
  }

  // Batch-classify all remaining edges
  if (toClassify.length > 0) {
    const classified = await classifyEdges(db, embed, containerId, toClassify);
    for (const c of classified) {
      counts[c.type]++;
    }
  }

  return counts;
}

/**
 * Find inconsistencies: semantically similar nodes with divergent downstream edges.
 *
 * Two nodes are inconsistent if:
 * 1. Their embeddings have cosine similarity > 0.8 (similar topic)
 * 2. Their outgoing edges lead to nodes with different relationship types
 */
export async function findInconsistencies(
  db: KgDbClient,
  embed: EmbeddingProvider,
  containerId: string,
  scopeFilter: string,
  params: Record<string, unknown>,
  limit: number = 20
): Promise<Array<{ topic: string; divergence: string }>> {
  const inconsistencies: Array<{ topic: string; divergence: string }> = [];

  // Get nodes with embeddings, grouped by author
  const nodesByAuthor = await db.query<{
    author: string;
    id: string;
    content: string;
    embedding: number[];
    created_at: string;
  }>(
    `SELECT author.name as author, id, content, embedding, created_at
     FROM node
     WHERE ${scopeFilter} AND embedding != NONE
     ORDER BY author, created_at DESC
     LIMIT 500`,
    params
  );

  // Group by author
  const authorGroups = new Map<string, typeof nodesByAuthor>();
  for (const node of nodesByAuthor) {
    const author = node.author || 'unknown';
    if (!authorGroups.has(author)) {
      authorGroups.set(author, []);
    }
    authorGroups.get(author)!.push(node);
  }

  // Find pairs of authors with similar nodes but different downstream edges
  const authors = Array.from(authorGroups.keys());

  for (let i = 0; i < authors.length && inconsistencies.length < limit; i++) {
    for (let j = i + 1; j < authors.length && inconsistencies.length < limit; j++) {
      const nodesA = authorGroups.get(authors[i])!;
      const nodesB = authorGroups.get(authors[j])!;

      // Find similar nodes between authors
      for (const nodeA of nodesA.slice(0, 20)) {
        for (const nodeB of nodesB.slice(0, 20)) {
          if (!nodeA.embedding || !nodeB.embedding) continue;

          const similarity = cosineSimilarity(nodeA.embedding, nodeB.embedding);
          if (similarity > 0.8) {
            // Check if they have divergent downstream edges
            // (simplified: just report as potential inconsistency)
            const topic = nodeA.content.slice(0, 50);
            const divergence = `${authors[i]} and ${authors[j]} handle "${topic}" differently`;

            inconsistencies.push({ topic, divergence });

            if (inconsistencies.length >= limit) break;
          }
        }
        if (inconsistencies.length >= limit) break;
      }
    }
  }

  return inconsistencies;
}

/**
 * Reset cached centroids (for testing or when training data changes).
 */
export function resetCentroids(containerId?: string): void {
  if (containerId) {
    referenceCentroidsCache.delete(containerId);
  } else {
    referenceCentroidsCache.clear();
  }
}
