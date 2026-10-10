import type { DqFlag, DqRuleId, DqSeverity, Severity } from '@pic/shared';
import { config } from '../config.js';
import { normalizeOwner, type SnapshotRow } from './normalize.js';

/*
 * Data quality rules DQ01–DQ09. Each rule is a named pure function; rules only flag rows,
 * they never drop them. Treatments (NULLing, quarantine) are applied by the pipeline.
 */

// DQ01: owner is NaN or the 'ORPHANED_REPORT' placeholder.
export function isOrphanedOwner(rawOwner: string): boolean {
  return normalizeOwner(rawOwner) === null;
}

// DQ02: negative Snowflake credits are impossible; quarantined and excluded from attribution.
export function hasNegativeCredits(row: Pick<SnapshotRow, 'snowflake_credits_consumed'>): boolean {
  return row.snowflake_credits_consumed < 0;
}

// DQ03: load time above the warning threshold.
export function isSlowLoad(row: Pick<SnapshotRow, 'avg_load_time_sec'>): boolean {
  return row.avg_load_time_sec > config.LATENCY_WARNING_SEC;
}

/** Alert severity for a load time (strictly greater than each threshold). Reused by alert rules. */
export function latencySeverity(sec: number): Extract<Severity, 'WARNING' | 'CRITICAL'> | null {
  if (sec > config.LATENCY_CRITICAL_SEC) return 'CRITICAL';
  if (sec > config.LATENCY_WARNING_SEC) return 'WARNING';
  return null;
}

// DQ04: AWS cost per view outlier.
export interface CostStats {
  median: number;
  mad: number;
}

type CostFields = Pick<SnapshotRow, 'monthly_active_views' | 'aws_hosting_cost_usd'>;

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** ln(aws / views); null when either side is non-positive (log undefined). */
export function logCostPerView(row: CostFields): number | null {
  if (row.monthly_active_views <= 0 || row.aws_hosting_cost_usd <= 0) return null;
  return Math.log(row.aws_hosting_cost_usd / row.monthly_active_views);
}

/**
 * Median and MAD of ln(aws/views). Pooled across all rows of all snapshots (not per snapshot),
 * so a report is compared with the whole portfolio's history. Rows with a non-positive side
 * are skipped; zero-view rows are handled by DQ05.
 */
export function computeCostStats(rows: readonly CostFields[]): CostStats {
  const xs = rows.map(logCostPerView).filter((x): x is number => x !== null);
  const m = median(xs);
  return { median: m, mad: median(xs.map((x) => Math.abs(x - m))) };
}

/** Modified z-score (Iglewicz & Hoaglin): 0.6745 · (x − median) / MAD. */
export function robustZ(x: number, stats: CostStats): number {
  return (0.6745 * (x - stats.median)) / stats.mad;
}

export function isCostMismatch(row: CostFields, stats: CostStats): boolean {
  const hardRule =
    row.monthly_active_views < config.COST_LOW_VIEWS &&
    row.aws_hosting_cost_usd > config.COST_HIGH_AWS_USD;
  if (hardRule) return true;
  const x = logCostPerView(row);
  if (x === null || !(stats.mad > 0)) return false;
  return Math.abs(robustZ(x, stats)) > config.COST_ROBUST_Z;
}

// DQ05: zero monthly views; unit cost becomes NULL downstream (NULLIF).
export function hasZeroViews(row: Pick<SnapshotRow, 'monthly_active_views'>): boolean {
  return row.monthly_active_views === 0;
}

// DQ06: peak concurrent users cannot exceed monthly active views.
export function hasImpossibleConcurrency(
  row: Pick<SnapshotRow, 'concurrent_user_peak' | 'monthly_active_views'>,
): boolean {
  return row.concurrent_user_peak > row.monthly_active_views;
}

// DQ07: refresh status UNKNOWN (kept as its own bucket).
export function isUnknownRefresh(row: Pick<SnapshotRow, 'last_refresh_status'>): boolean {
  return row.last_refresh_status === 'UNKNOWN';
}

// DQ08: refresh reported SUCCESS but the load is slow.
export function isSlowButHealthy(
  row: Pick<SnapshotRow, 'last_refresh_status' | 'avg_load_time_sec'>,
): boolean {
  return row.last_refresh_status === 'SUCCESS' && isSlowLoad(row);
}

// DQ09: ownership change event. `prevOwner` is undefined for a report's first snapshot.
export function ownerChanged(prevOwner: string | null | undefined, owner: string | null): boolean {
  return prevOwner !== undefined && prevOwner !== owner;
}

/**
 * current_owner = normalized owner in the latest snapshot, unless an override exists (an
 * override wins even when it is null). NULL means the report is currently orphaned. Ingest runs
 * with no overrides; at runtime the SQL view REPORT_CURRENT_OWNER (/sql/01) applies the same rule
 * over OWNER_OVERRIDES.
 */
export function resolveCurrentOwner(
  ownerHistory: readonly (string | null)[],
  override?: string | null,
): string | null {
  if (override !== undefined) return override;
  return ownerHistory.at(-1) ?? null;
}

/** Context a row needs beyond its own fields. */
export interface RuleContext {
  costStats: CostStats;
  prevOwner: string | null | undefined;
}

export interface DqRule {
  id: DqRuleId;
  name: string;
  severity: DqSeverity;
  treatment: string;
  flag: DqFlag;
  applies: (row: SnapshotRow, ctx: RuleContext) => boolean;
}

export const DQ_RULES: readonly DqRule[] = [
  {
    id: 'DQ01',
    name: 'Orphaned owner',
    severity: 'high',
    treatment:
      "Owner 'nan', 'ORPHANED_REPORT' or empty (trimmed, case-insensitive) normalized to NULL; flag ORPHANED",
    flag: 'ORPHANED',
    applies: (row) => isOrphanedOwner(row.owner_raw),
  },
  {
    id: 'DQ02',
    name: 'Negative Snowflake credits',
    severity: 'high',
    treatment: 'Copied to QUARANTINE; credits_clean = NULL; excluded from cost attribution',
    flag: 'NEGATIVE_CREDITS',
    applies: (row) => hasNegativeCredits(row),
  },
  {
    id: 'DQ03',
    name: `Slow load (> ${config.LATENCY_WARNING_SEC}s)`,
    severity: 'medium',
    treatment: `Kept; alert trigger (WARNING > ${config.LATENCY_WARNING_SEC}s, CRITICAL > ${config.LATENCY_CRITICAL_SEC}s)`,
    flag: 'SLOW_LOAD',
    applies: (row) => isSlowLoad(row),
  },
  {
    id: 'DQ04',
    name: 'AWS cost per view outlier',
    severity: 'medium',
    treatment: `Kept; flag COST_MISMATCH (robust z > ${config.COST_ROBUST_Z} on ln(aws/views), or views < ${config.COST_LOW_VIEWS} and AWS > $${config.COST_HIGH_AWS_USD})`,
    flag: 'COST_MISMATCH',
    applies: (row, ctx) => isCostMismatch(row, ctx.costStats),
  },
  {
    id: 'DQ05',
    name: 'Zero monthly views',
    severity: 'medium',
    treatment: 'Kept; unit cost = NULL (NULLIF); flag ZERO_VIEWS',
    flag: 'ZERO_VIEWS',
    applies: (row) => hasZeroViews(row),
  },
  {
    id: 'DQ06',
    name: 'Impossible concurrency',
    severity: 'low',
    treatment: 'Kept; concurrent_user_peak > monthly_active_views; flag IMPOSSIBLE_CONCURRENCY',
    flag: 'IMPOSSIBLE_CONCURRENCY',
    applies: (row) => hasImpossibleConcurrency(row),
  },
  {
    id: 'DQ07',
    name: 'Unknown refresh status',
    severity: 'low',
    treatment: 'Kept as its own status bucket; raises an INFO alert',
    flag: 'UNKNOWN_REFRESH',
    applies: (row) => isUnknownRefresh(row),
  },
  {
    id: 'DQ08',
    name: 'Slow but healthy',
    severity: 'info',
    treatment: `Kept; refresh SUCCESS but load > ${config.LATENCY_WARNING_SEC}s; flag SLOW_BUT_HEALTHY`,
    flag: 'SLOW_BUT_HEALTHY',
    applies: (row) => isSlowButHealthy(row),
  },
  {
    id: 'DQ09',
    name: 'Ownership change (event)',
    severity: 'info',
    treatment:
      'Expected event, not a defect: row owner differs from the previous snapshot; owner_history kept; current_owner = latest snapshot owner',
    flag: 'OWNER_CHANGED',
    applies: (row, ctx) => ownerChanged(ctx.prevOwner, row.owner_email),
  },
];

/** All flags that apply to one row, in rule order. */
export function flagRow(row: SnapshotRow, ctx: RuleContext): DqFlag[] {
  return DQ_RULES.filter((rule) => rule.applies(row, ctx)).map((rule) => rule.flag);
}
