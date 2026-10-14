import type { Surreal } from 'surrealdb';

export interface ReembedNode {
  id: unknown;
  content: string;
}

/**
 * The value of `--limit N`, or undefined when the flag is absent (no limit).
 * Throws on a missing value or anything but a positive integer: parseInt would
 * read `--limit` with no value as NaN and `--limit 0` as 0, and both used to
 * mean "re-embed everything".
 */
export function parseLimitArg(args: readonly string[]): number | undefined {
  const idx = args.indexOf('--limit');
  if (idx < 0) return undefined;
  const raw = args[idx + 1];
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    throw new Error(`--limit needs a positive integer (got ${raw === undefined ? 'no value' : `'${raw}'`})`);
  }
  return Number(raw);
}

/**
 * Nodes bin/reembed.ts must (re-)embed for `model`: no vector, a vector of the
 * wrong length, or one recorded under another model (or none). Nodes without
 * content have nothing to embed. Root connection: spans every tenant.
 * `limit` undefined means every such node.
 */
export async function buildWorkList(
  db: Surreal,
  model: string,
  dims: number,
  limit?: number
): Promise<ReembedNode[]> {
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
    throw new Error(`buildWorkList: limit must be a positive integer or undefined (got ${limit})`);
  }
  const params: Record<string, unknown> = { model, dim: dims };
  if (limit !== undefined) params.limit = limit;
  const [workList] = await db.query<[ReembedNode[]]>(
    `SELECT id, content FROM node
     WHERE content != '' AND content != NONE
     AND (embedding = NONE OR array::len(embedding) != $dim OR embedding_model != $model)
     ${limit !== undefined ? 'LIMIT $limit' : ''}`,
    params
  );
  return workList;
}
