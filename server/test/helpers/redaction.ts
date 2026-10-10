/**
 * The second, independent check on viewer redaction (the first is the viewer zod schemas in
 * http/route.ts). Deliberately broad: any key that looks like money or credits counts, so a new
 * cost field is caught even if nobody adds it to a list.
 */
// robustZ / awsLogZ: z-scores of log cost per view; with `views` they reveal cost per view.
export const COST_KEY = /cost|credit|usd|share|robustz|logz/i;

/** Aggregates every role may see live under keys named `totals`. */
const ALLOWED_PARENT = 'totals';

/** Paths ("items[0].awsCostUsd") of cost keys outside `totals` objects. */
export function costKeyPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => costKeyPaths(v, `${path}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, v]) => {
    if (key === ALLOWED_PARENT) return [];
    const here = `${path}.${key}`;
    return [...(COST_KEY.test(key) ? [here] : []), ...costKeyPaths(v, here)];
  });
}
