/*
 * Synthetic SNOWFLAKE.ACCOUNT_USAGE data: QUERY_HISTORY and WAREHOUSE_METERING_HISTORY.
 *
 * Construction (see /sql/README.md for why it reconciles exactly):
 * 1. Each (report, snapshot) with non-null credits_clean becomes n = max(1, round(q30 / 300))
 *    queries on the report's warehouse. Its credits map to a whole number of execution
 *    milliseconds, total_ms = credits_clean × MS_PER_CREDIT[warehouse], split across the queries
 *    by seeded lognormal weights (integer parts that sum to total_ms exactly).
 * 2. END_TIME = START_TIME + EXECUTION_TIME; start times follow a diurnal curve over the
 *    snapshot's UTC day. Long queries cross hour boundaries (and sometimes midnight).
 * 3. Metering per warehouse-hour = execution ms inside that hour / MS_PER_CREDIT
 *    × (1 + SIMULATED_OVERHEAD_RATE). Because one warehouse has one MS_PER_CREDIT, execution-time
 *    share equals credit share inside every hour, which is what the attribution SQL relies on.
 *
 * Deterministic: every row gets its own PRNG seeded from (SIM_SEED, report_id, snapshot_idx), so
 * output does not depend on row order and never uses Math.random or the clock. Input is
 * credits_clean only (quarantined negatives are already NULL), so they cannot leak into usage.
 */
import { timestampValueFromDate, type DuckDBConnection } from '@duckdb/node-api';
import { config, type WarehouseName } from '../config.js';
import type { SnapshotRow } from './normalize.js';

const HOUR_MS = 3_600_000;
/** BI tools run every dashboard query as one service user, so QUERY_TAG is the only report link. */
export const SIM_USER_NAME = 'PURE_INSIGHTS_SVC';
export const SIM_ROLE_NAME = 'REPORTING_ROLE';

export type SimInputRow = Pick<
  SnapshotRow,
  'report_id' | 'snapshot_idx' | 'snapshot_date' | 'query_count_last_30d' | 'last_refresh_status'
> & { credits_clean: number | null };

export interface SimQuery {
  QUERY_ID: string;
  QUERY_TAG: string;
  WAREHOUSE_NAME: WarehouseName;
  USER_NAME: string;
  ROLE_NAME: string;
  /** Epoch milliseconds, UTC. */
  START_TIME: number;
  END_TIME: number;
  /** Milliseconds; always START_TIME..END_TIME here (no queueing or compilation time). */
  EXECUTION_TIME: number;
  EXECUTION_STATUS: 'SUCCESS' | 'FAIL';
  /** Ground truth for tests only. The attribution SQL never reads it. */
  _SIM_TRUE_CREDITS: number;
}

export interface SimMeteringRow {
  START_TIME: number;
  END_TIME: number;
  WAREHOUSE_NAME: WarehouseName;
  CREDITS_USED: number;
  CREDITS_USED_COMPUTE: number;
  CREDITS_USED_CLOUD_SERVICES: number;
}

/** mulberry32: small, fast, seedable PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** 32-bit FNV-1a hash of a string's UTF-16 code units. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The warehouse a report always runs on: WAREHOUSES[fnv1a32(report_id) % 3]. */
export function warehouseFor(reportId: string): WarehouseName {
  return config.WAREHOUSES[fnv1a32(reportId) % config.WAREHOUSES.length] as WarehouseName;
}

/** Queries generated for one (report, snapshot): max(1, round(query_count_last_30d / 300)). */
export function queryCount(queryCountLast30d: number): number {
  return Math.max(1, Math.round(queryCountLast30d / 300));
}

/**
 * Splits integer `total` into weights.length integer parts, each ≥ 1, summing to `total` exactly:
 * one unit each, then the rest by largest remainder (ties go to the lower index).
 */
export function apportion(total: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (!Number.isInteger(total) || n === 0 || total < n) {
    throw new Error(`Cannot split ${total} into ${n} positive integer parts`);
  }
  if (weights.some((w) => !(w > 0) || !Number.isFinite(w))) {
    throw new Error('Weights must be positive finite numbers');
  }
  const spare = total - n;
  const sumW = weights.reduce((s, w) => s + w, 0);
  const exact = weights.map((w) => (spare * w) / sumW);
  const parts = exact.map(Math.floor);
  const left = spare - parts.reduce((s, p) => s + p, 0);
  if (left < 0 || left > n) throw new Error(`Apportionment drifted by ${left}`);
  const byRemainder = exact
    .map((x, i) => ({ i, r: x - (parts[i] as number) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; k < left; k++) parts[byRemainder[k]!.i]! += 1;
  return parts.map((p) => p + 1);
}

/**
 * Whole execution milliseconds for `credits` on a warehouse. Exact because credits carry at most
 * 2 decimals and every MS_PER_CREDIT is a multiple of 100; anything else throws.
 */
export function creditsToMs(credits: number, msPerCredit: number): number {
  if (!Number.isInteger(msPerCredit / 100)) {
    throw new Error(`MS_PER_CREDIT ${msPerCredit} must be a multiple of 100`);
  }
  const cents = Math.round(credits * 100);
  if (Math.abs(credits * 100 - cents) > 1e-6 || cents < 0) {
    throw new Error(`credits ${credits} must be non-negative with at most 2 decimals`);
  }
  return cents * (msPerCredit / 100);
}

function standardNormal(rand: () => number): number {
  const u1 = 1 - rand(); // (0, 1], so log is finite
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function pickWeighted(weights: readonly number[], rand: () => number): number {
  const total = weights.reduce((s, w) => s + w, 0);
  let x = rand() * total;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i] as number;
    if (x < 0) return i;
  }
  return weights.length - 1;
}

const hex = (n: number, width: number) => n.toString(16).padStart(width, '0').slice(-width);

/** UUID-shaped id, unique by construction: (report hash, snapshot, query index) + random tail. */
function queryId(row: SimInputRow, index: number, rand: () => number): string {
  return [
    hex(fnv1a32(row.report_id), 8),
    hex(row.snapshot_idx, 4),
    hex(index, 4),
    hex(Math.floor(rand() * 0x10000), 4),
    hex(Math.floor(rand() * 2 ** 48), 12),
  ].join('-');
}

/** All queries for one (report, snapshot) row; none when credits_clean is NULL or zero. */
export function simulateRow(row: SimInputRow): SimQuery[] {
  if (row.credits_clean === null) return [];
  const warehouse = warehouseFor(row.report_id);
  const msPerCredit = config.MS_PER_CREDIT[warehouse];
  const totalMs = creditsToMs(row.credits_clean, msPerCredit);
  if (totalMs === 0) return [];

  const rand = mulberry32(fnv1a32(`${config.SIM_SEED}|${row.report_id}|${row.snapshot_idx}`));
  const n = Math.min(queryCount(row.query_count_last_30d), totalMs);
  const weights = Array.from({ length: n }, () =>
    Math.exp(config.SIM_EXEC_LOG_SIGMA * standardNormal(rand)),
  );
  const execMs = apportion(totalMs, weights);
  const dayStart = Date.parse(`${row.snapshot_date}T00:00:00Z`);
  const tag = JSON.stringify({ report_id: row.report_id });
  const failed = row.last_refresh_status === 'FAILED' || row.last_refresh_status === 'TIMED_OUT';

  return execMs.map((ms, i) => {
    const hour = pickWeighted(config.SIM_HOURLY_WEIGHTS, rand);
    const start = dayStart + hour * HOUR_MS + Math.floor(rand() * HOUR_MS);
    return {
      QUERY_ID: queryId(row, i, rand),
      QUERY_TAG: tag,
      WAREHOUSE_NAME: warehouse,
      USER_NAME: SIM_USER_NAME,
      ROLE_NAME: SIM_ROLE_NAME,
      START_TIME: start,
      END_TIME: start + ms,
      EXECUTION_TIME: ms,
      // A failed refresh still bills the compute it used, so attribution ignores status.
      EXECUTION_STATUS: failed && i === n - 1 ? 'FAIL' : 'SUCCESS',
      _SIM_TRUE_CREDITS: ms / msPerCredit,
    };
  });
}

export function simulateQueries(rows: readonly SimInputRow[]): SimQuery[] {
  return rows.flatMap(simulateRow);
}

/** Calls fn(hourStart, msInsideHour) for every UTC hour the query's execution overlaps. */
export function forEachHourSlice(
  q: Pick<SimQuery, 'START_TIME' | 'END_TIME'>,
  fn: (hourStart: number, ms: number) => void,
): void {
  for (let h = Math.floor(q.START_TIME / HOUR_MS) * HOUR_MS; h < q.END_TIME; h += HOUR_MS) {
    const ms = Math.min(q.END_TIME, h + HOUR_MS) - Math.max(q.START_TIME, h);
    if (ms > 0) fn(h, ms);
  }
}

/**
 * Hourly metering per warehouse: execution ms inside the hour (summed as integers, then
 * converted once) / MS_PER_CREDIT × (1 + SIMULATED_OVERHEAD_RATE). Only hours with activity get
 * a row. Sorted by warehouse then hour.
 */
export function meterWarehouses(queries: readonly SimQuery[]): SimMeteringRow[] {
  const msByHour = new Map<string, { warehouse: WarehouseName; hour: number; ms: number }>();
  for (const q of queries) {
    forEachHourSlice(q, (hour, ms) => {
      const key = `${q.WAREHOUSE_NAME}|${hour}`;
      const slot = msByHour.get(key) ?? { warehouse: q.WAREHOUSE_NAME, hour, ms: 0 };
      slot.ms += ms;
      msByHour.set(key, slot);
    });
  }
  return [...msByHour.values()]
    .sort((a, b) => a.warehouse.localeCompare(b.warehouse) || a.hour - b.hour)
    .map(({ warehouse, hour, ms }) => {
      const compute = (ms / config.MS_PER_CREDIT[warehouse]) * (1 + config.SIMULATED_OVERHEAD_RATE);
      return {
        START_TIME: hour,
        END_TIME: hour + HOUR_MS,
        WAREHOUSE_NAME: warehouse,
        CREDITS_USED: compute,
        CREDITS_USED_COMPUTE: compute,
        CREDITS_USED_CLOUD_SERVICES: 0,
      };
    });
}

const ts = (ms: number) => timestampValueFromDate(new Date(ms));

/**
 * Generates and appends ACCOUNT_USAGE.QUERY_HISTORY and ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY.
 * The tables must already exist (/sql/01_schema.sql); column order matches that DDL.
 */
export async function writeSnowflakeSim(
  conn: DuckDBConnection,
  rows: readonly SimInputRow[],
): Promise<{ queries: number; meteringRows: number }> {
  const queries = simulateQueries(rows);
  const metering = meterWarehouses(queries);

  const qa = await conn.createAppender('QUERY_HISTORY', 'ACCOUNT_USAGE');
  try {
    for (const q of queries) {
      qa.appendVarchar(q.QUERY_ID);
      qa.appendVarchar(q.QUERY_TAG);
      qa.appendVarchar(q.WAREHOUSE_NAME);
      qa.appendVarchar(q.USER_NAME);
      qa.appendVarchar(q.ROLE_NAME);
      qa.appendTimestamp(ts(q.START_TIME));
      qa.appendTimestamp(ts(q.END_TIME));
      qa.appendBigInt(BigInt(q.EXECUTION_TIME));
      qa.appendVarchar(q.EXECUTION_STATUS);
      qa.appendDouble(q._SIM_TRUE_CREDITS);
      qa.endRow();
    }
  } finally {
    qa.closeSync();
  }

  const ma = await conn.createAppender('WAREHOUSE_METERING_HISTORY', 'ACCOUNT_USAGE');
  try {
    for (const m of metering) {
      ma.appendTimestamp(ts(m.START_TIME));
      ma.appendTimestamp(ts(m.END_TIME));
      ma.appendVarchar(m.WAREHOUSE_NAME);
      ma.appendDouble(m.CREDITS_USED);
      ma.appendDouble(m.CREDITS_USED_COMPUTE);
      ma.appendDouble(m.CREDITS_USED_CLOUD_SERVICES);
      ma.endRow();
    }
  } finally {
    ma.closeSync();
  }

  return { queries: queries.length, meteringRows: metering.length };
}
