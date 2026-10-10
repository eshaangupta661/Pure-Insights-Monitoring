import type { DuckDBValue } from '@duckdb/node-api';
import type { Page } from '@pic/shared';
import { z } from '../api/zod.js';
import { config } from '../config.js';
import type { Queryable } from '../data/warehouse.js';

/** `?page=&pageSize=`, merged into every list endpoint's query schema. */
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).openapi({ description: '1-based page number' }),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(config.PAGE_SIZE_MAX)
    .default(config.PAGE_SIZE_DEFAULT)
    .openapi({ description: `Items per page (max ${config.PAGE_SIZE_MAX})` }),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

/** Response schema for a page of `item`. */
export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  });
}

/**
 * Runs `SELECT COUNT(*)` over `sql`, then `sql ORDER BY orderBy LIMIT/OFFSET`. `sql` is the
 * filtered SELECT without ORDER BY (so the count doesn't sort). `orderBy` must make the order
 * total (end with a unique column) or rows can repeat or vanish across pages. A page past the
 * end returns no items and the real total.
 */
export async function paginate<T>(
  db: Queryable,
  sql: string,
  params: readonly DuckDBValue[],
  orderBy: string,
  { page, pageSize }: PageQuery,
): Promise<Page<T>> {
  const [count] = await db.query<{ n: number }>(
    `SELECT COUNT(*)::INTEGER AS n FROM (${sql}) AS filtered`,
    [...params],
  );
  const total = count?.n ?? 0;
  const offset = (page - 1) * pageSize;
  const items =
    offset >= total
      ? []
      : await db.query<T>(
          `${sql} ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset],
        );
  return { items, page, pageSize, total };
}

/** The same contract for data already in memory (alerts). */
export function paginateArray<T>(all: readonly T[], { page, pageSize }: PageQuery): Page<T> {
  const offset = (page - 1) * pageSize;
  return { items: all.slice(offset, offset + pageSize), page, pageSize, total: all.length };
}
