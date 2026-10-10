import type { AuthUser } from '@pic/shared';
import { HttpError } from './errors.js';

export interface SortSpec<S extends string> {
  /** ORDER BY expression per sort key (whitelisted; never user text). */
  columns: Record<S, string>;
  /** Direction used when `order` is omitted. */
  defaultOrder: Record<S, 'asc' | 'desc'>;
  /** Keys that order rows by money; a viewer could read cost ranks from them. */
  costKeys: readonly S[];
  defaultKey: S;
  viewerDefaultKey: S;
  /** Appended to every ORDER BY so the order is total (pages never overlap). */
  tieBreak: string;
}

/**
 * The ORDER BY clause for a list endpoint. Viewers get a non-cost default and a 403 if they ask
 * for a cost sort explicitly, since the row order itself would reveal per-report cost ranks.
 */
export function orderByFor<S extends string>(
  spec: SortSpec<S>,
  user: AuthUser,
  sort: S | undefined,
  order: 'asc' | 'desc' | undefined,
): string {
  const isViewer = user.role === 'viewer';
  if (isViewer && sort !== undefined && spec.costKeys.includes(sort)) {
    throw new HttpError(403, 'FORBIDDEN', `Viewers can't sort by cost (sort=${sort})`);
  }
  const key = sort ?? (isViewer ? spec.viewerDefaultKey : spec.defaultKey);
  const direction = (order ?? spec.defaultOrder[key]) === 'desc' ? 'DESC' : 'ASC';
  return `${spec.columns[key]} ${direction} NULLS LAST, ${spec.tieBreak}`;
}
