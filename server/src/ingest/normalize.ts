import { z } from 'zod';
import { config, type RefreshStatus } from '../config.js';
import type { RawRow } from './csv.js';

/** Typed snapshot row before DQ treatment. owner_email is already normalized (NULL = orphaned). */
export interface SnapshotRow {
  row_idx: number;
  snapshot_idx: number;
  snapshot_date: string; // YYYY-MM-DD
  report_id: string;
  report_name: string;
  owner_raw: string;
  owner_email: string | null;
  last_refresh_status: RefreshStatus;
  monthly_active_views: number;
  snowflake_credits_consumed: number;
  avg_load_time_sec: number;
  aws_hosting_cost_usd: number;
  query_count_last_30d: number;
  concurrent_user_peak: number;
}

const ORPHAN_MARKERS: ReadonlySet<string> = new Set(config.ORPHAN_OWNER_MARKERS);

/**
 * Trimmed, lowercased owner email, or null for an orphan marker (matched case-insensitively).
 * Lowercasing matters: owner access is checked by exact match in SQL and socket rooms.
 */
export function normalizeOwner(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  return ORPHAN_MARKERS.has(v) ? null : v;
}

const refreshStatusSchema = z.enum(config.REFRESH_STATUSES);

/** Trimmed, uppercased refresh status; throws on anything outside REFRESH_STATUSES. */
export function normalizeRefreshStatus(raw: string, rowIdx: number): RefreshStatus {
  const parsed = refreshStatusSchema.safeParse(raw.trim().toUpperCase());
  if (!parsed.success) {
    throw new Error(
      `Row ${rowIdx}: unknown last_refresh_status "${raw}" (expected one of ${config.REFRESH_STATUSES.join(', ')})`,
    );
  }
  return parsed.data;
}

/** Adds `days` to an ISO date (UTC), returning YYYY-MM-DD. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function toNumber(value: string, column: string, rowIdx: number): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n)) {
    throw new Error(`Row ${rowIdx}: ${column} is not a number: "${value}"`);
  }
  return n;
}

function toInteger(value: string, column: string, rowIdx: number): number {
  const n = toNumber(value, column, rowIdx);
  if (!Number.isInteger(n))
    throw new Error(`Row ${rowIdx}: ${column} is not an integer: "${value}"`);
  return n;
}

/**
 * Types one raw row. The CSV stacks snapshots in blocks of `reportsPerSnapshot` rows, so
 * snapshot_idx = floor(rowIdx / reportsPerSnapshot).
 */
export function toSnapshotRow(
  raw: RawRow,
  rowIdx: number,
  reportsPerSnapshot: number,
): SnapshotRow {
  const snapshotIdx = Math.floor(rowIdx / reportsPerSnapshot);
  return {
    row_idx: rowIdx,
    snapshot_idx: snapshotIdx,
    snapshot_date: addDays(config.SNAPSHOT_BASE_DATE, snapshotIdx),
    report_id: raw.report_id,
    report_name: raw.report_name,
    owner_raw: raw.owner_email,
    owner_email: normalizeOwner(raw.owner_email),
    last_refresh_status: normalizeRefreshStatus(raw.last_refresh_status, rowIdx),
    monthly_active_views: toInteger(raw.monthly_active_views, 'monthly_active_views', rowIdx),
    snowflake_credits_consumed: toNumber(
      raw.snowflake_credits_consumed,
      'snowflake_credits_consumed',
      rowIdx,
    ),
    avg_load_time_sec: toNumber(raw.avg_load_time_sec, 'avg_load_time_sec', rowIdx),
    aws_hosting_cost_usd: toNumber(raw.aws_hosting_cost_usd, 'aws_hosting_cost_usd', rowIdx),
    query_count_last_30d: toInteger(raw.query_count_last_30d, 'query_count_last_30d', rowIdx),
    concurrent_user_peak: toInteger(raw.concurrent_user_peak, 'concurrent_user_peak', rowIdx),
  };
}
