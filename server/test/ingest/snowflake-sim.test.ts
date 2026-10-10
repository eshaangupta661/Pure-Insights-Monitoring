import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { parseCsv } from '../../src/ingest/csv.js';
import { flagRows } from '../../src/ingest/pipeline.js';
import {
  apportion,
  creditsToMs,
  fnv1a32,
  forEachHourSlice,
  meterWarehouses,
  mulberry32,
  queryCount,
  simulateQueries,
  simulateRow,
  warehouseFor,
  type SimInputRow,
  type SimQuery,
} from '../../src/ingest/snowflake-sim.js';
import { RAW_CSV, ROOT_DIR } from '../../src/paths.js';

const HOUR_MS = 3_600_000;
const RATE = 1 + config.SIMULATED_OVERHEAD_RATE;

function row(overrides: Partial<SimInputRow> = {}): SimInputRow {
  return {
    report_id: 'RPT_200',
    snapshot_idx: 0,
    snapshot_date: '2026-09-21',
    credits_clean: 857.88,
    query_count_last_30d: 12825,
    last_refresh_status: 'SUCCESS',
    ...overrides,
  };
}

const rowKey = (r: Pick<SimInputRow, 'report_id' | 'snapshot_date'>) =>
  `${r.report_id}|${r.snapshot_date}`;
const queryKey = (q: SimQuery) =>
  `${(JSON.parse(q.QUERY_TAG) as { report_id: string }).report_id}|${new Date(q.START_TIME).toISOString().slice(0, 10)}`;

describe('PRNG and hashing', () => {
  it('mulberry32 is deterministic per seed and returns [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(mulberry32(43)()).not.toBe(xs[0]);
  });

  it('fnv1a32 matches the reference vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('warehouseFor is stable and spreads the 100 reports over all 3 warehouses', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `RPT_${200 + i}`);
    const counts = new Map<string, number>();
    for (const id of ids) {
      expect(warehouseFor(id)).toBe(warehouseFor(id));
      counts.set(warehouseFor(id), (counts.get(warehouseFor(id)) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual([...config.WAREHOUSES].sort());
    for (const n of counts.values()) expect(n).toBeGreaterThanOrEqual(20);
  });
});

describe('queryCount', () => {
  it.each([
    [20, 1],
    [449, 1],
    [450, 2],
    [12825, 43],
    [24998, 83],
  ])('q30 = %i → %i queries', (q30, n) => {
    expect(queryCount(q30)).toBe(n);
  });
});

describe('apportion', () => {
  it('returns integer parts ≥ 1 that sum to the total exactly', () => {
    const rand = mulberry32(7);
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(rand() * 83);
      const total = n + Math.floor(rand() * 5_000_000);
      const weights = Array.from({ length: n }, () => Math.exp(2 * (rand() - 0.5)));
      const parts = apportion(total, weights);
      expect(parts).toHaveLength(n);
      expect(parts.every((p) => Number.isInteger(p) && p >= 1)).toBe(true);
      expect(parts.reduce((s, p) => s + p, 0)).toBe(total);
    }
  });

  it('is proportional, with remainders going to the largest fractions', () => {
    expect(apportion(13, [1, 1, 1])).toEqual([5, 4, 4]);
    expect(apportion(103, [1, 2, 97])).toEqual([2, 3, 98]);
  });

  it('rejects impossible splits', () => {
    expect(() => apportion(2, [1, 1, 1])).toThrow(/positive integer parts/);
    expect(() => apportion(10, [1, 0])).toThrow(/positive finite/);
  });
});

describe('creditsToMs', () => {
  it('maps 2-decimal credits to whole milliseconds exactly', () => {
    expect(creditsToMs(857.88, 3600)).toBe(3_088_368);
    expect(creditsToMs(0.01, 900)).toBe(9);
  });

  it('throws on more than 2 decimals, negatives, or a non-multiple-of-100 rate', () => {
    expect(() => creditsToMs(1.234, 3600)).toThrow(/at most 2 decimals/);
    expect(() => creditsToMs(-1, 3600)).toThrow(/non-negative/);
    expect(() => creditsToMs(1, 3650)).toThrow(/multiple of 100/);
    expect(() => simulateRow(row({ credits_clean: 1.234 }))).toThrow(/at most 2 decimals/);
  });
});

describe('simulateRow', () => {
  it('generates no queries for NULL (quarantined) or zero credits', () => {
    expect(simulateRow(row({ credits_clean: null }))).toEqual([]);
    expect(simulateRow(row({ credits_clean: 0 }))).toEqual([]);
  });

  it('tags every query and marks only the last query of a failed refresh as FAIL', () => {
    for (const status of ['FAILED', 'TIMED_OUT'] as const) {
      const qs = simulateRow(row({ last_refresh_status: status }));
      expect(qs.map((q) => q.EXECUTION_STATUS)).toEqual([
        ...Array<string>(qs.length - 1).fill('SUCCESS'),
        'FAIL',
      ]);
    }
    const ok = simulateRow(row({ last_refresh_status: 'UNKNOWN' }));
    expect(ok.every((q) => q.EXECUTION_STATUS === 'SUCCESS')).toBe(true);
    expect(ok.every((q) => q.QUERY_TAG === '{"report_id":"RPT_200"}')).toBe(true);
  });
});

describe('simulateQueries on the real CSV', () => {
  const rows = flagRows(parseCsv(fs.readFileSync(RAW_CSV, 'utf8')));
  const queries = simulateQueries(rows);
  const byRow = new Map<string, SimQuery[]>();
  for (const q of queries) {
    const list = byRow.get(queryKey(q)) ?? [];
    list.push(q);
    byRow.set(queryKey(q), list);
  }

  it('generates max(1, round(q30/300)) queries per costed row: 83,003 in total', () => {
    expect(queries).toHaveLength(83_003);
    const costed = rows.filter((r) => r.credits_clean !== null);
    expect(costed).toHaveLength(1976);
    expect(byRow.size).toBe(1976);
    for (const r of costed) {
      expect(byRow.get(rowKey(r))).toHaveLength(queryCount(r.query_count_last_30d));
    }
    for (const r of rows.filter((x) => x.credits_clean === null)) {
      expect(byRow.has(rowKey(r))).toBe(false);
    }
  });

  it('splits each row into whole ms summing exactly to credits_clean × MS_PER_CREDIT', () => {
    const bad: string[] = [];
    let maxCreditError = 0;
    for (const r of rows) {
      if (r.credits_clean === null) continue;
      const qs = byRow.get(rowKey(r))!;
      const warehouse = warehouseFor(r.report_id);
      const mpc = config.MS_PER_CREDIT[warehouse];
      const ms = qs.reduce((s, q) => s + q.EXECUTION_TIME, 0);
      if (qs.some((q) => q.WAREHOUSE_NAME !== warehouse)) bad.push(`${rowKey(r)} warehouse`);
      if (ms !== Math.round(r.credits_clean * 100) * (mpc / 100)) bad.push(`${rowKey(r)} ms`);
      const trueCredits = qs.reduce((s, q) => s + q._SIM_TRUE_CREDITS, 0);
      maxCreditError = Math.max(maxCreditError, Math.abs(trueCredits - r.credits_clean));
    }
    expect(bad).toEqual([]);
    expect(maxCreditError).toBeLessThan(1e-9);
  });

  it('produces well-formed rows: unique ids, END = START + EXEC, starts within the snapshot day', () => {
    expect(new Set(queries.map((q) => q.QUERY_ID)).size).toBe(queries.length);
    const idShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const malformed = queries.filter(
      (q) =>
        !idShape.test(q.QUERY_ID) ||
        !Number.isInteger(q.EXECUTION_TIME) ||
        q.EXECUTION_TIME < 1 ||
        q.END_TIME !== q.START_TIME + q.EXECUTION_TIME ||
        q.USER_NAME !== 'PURE_INSIGHTS_SVC',
    );
    expect(malformed).toEqual([]);
    // queryKey buckets by START_TIME's date, so every bucket matching a CSV row proves each
    // query starts inside its own snapshot's day.
    expect([...byRow.keys()].sort()).toEqual(
      rows
        .filter((r) => r.credits_clean !== null)
        .map(rowKey)
        .sort(),
    );
  });

  it('marks exactly one FAIL query per costed FAILED / TIMED_OUT row', () => {
    const failedRows = rows.filter(
      (r) =>
        r.credits_clean !== null &&
        (r.last_refresh_status === 'FAILED' || r.last_refresh_status === 'TIMED_OUT'),
    );
    expect(queries.filter((q) => q.EXECUTION_STATUS === 'FAIL')).toHaveLength(failedRows.length);
  });

  it('is deterministic and independent of row order', () => {
    // Compare compact fingerprints rather than deep-equalling 83k objects.
    const fingerprint = (qs: readonly SimQuery[]) =>
      qs
        .map((q) => `${q.QUERY_ID}|${q.START_TIME}|${q.EXECUTION_TIME}|${q.EXECUTION_STATUS}`)
        .sort()
        .join('\n');
    const expected = fingerprint(queries);
    expect(fingerprint(simulateQueries(rows))).toBe(expected);
    expect(fingerprint(simulateQueries([...rows].reverse()))).toBe(expected);
    expect(simulateQueries(rows).slice(0, 50)).toEqual(queries.slice(0, 50));
  });

  it('has queries that cross an hour boundary (exercises overlap splitting)', () => {
    const spanning = queries.filter(
      (q) => Math.floor(q.START_TIME / HOUR_MS) !== Math.floor((q.END_TIME - 1) / HOUR_MS),
    );
    expect(spanning.length).toBeGreaterThan(100);
    const mismatched = spanning.filter((q) => {
      let total = 0;
      let slices = 0;
      forEachHourSlice(q, (_h, ms) => {
        total += ms;
        slices++;
      });
      return total !== q.EXECUTION_TIME || slices < 2;
    });
    expect(mismatched).toEqual([]);
  });

  describe('meterWarehouses', () => {
    const metering = meterWarehouses(queries);

    it('meters (1 + SIMULATED_OVERHEAD_RATE) × query credits in total and per warehouse', () => {
      const trueTotal = queries.reduce((s, q) => s + q._SIM_TRUE_CREDITS, 0);
      const metered = metering.reduce((s, m) => s + m.CREDITS_USED, 0);
      expect(Math.abs(metered - trueTotal * RATE)).toBeLessThan(1e-6);
      for (const wh of config.WAREHOUSES) {
        const t = queries
          .filter((q) => q.WAREHOUSE_NAME === wh)
          .reduce((s, q) => s + q._SIM_TRUE_CREDITS, 0);
        const m = metering
          .filter((x) => x.WAREHOUSE_NAME === wh)
          .reduce((s, x) => s + x.CREDITS_USED, 0);
        expect(Math.abs(m - t * RATE)).toBeLessThan(1e-6);
      }
    });

    it('meters each hour as the overlapping execution ms (recomputed independently for day 0)', () => {
      const day1 = Date.parse('2026-09-22T00:00:00Z');
      const day0Queries = queries.filter((q) => q.START_TIME < day1);
      const day0Hours = metering.filter((m) => m.START_TIME < day1);
      expect(day0Hours.length).toBeGreaterThan(0);
      let maxError = 0;
      for (const m of day0Hours) {
        let ms = 0;
        for (const q of day0Queries) {
          if (q.WAREHOUSE_NAME !== m.WAREHOUSE_NAME) continue;
          ms += Math.max(
            0,
            Math.min(q.END_TIME, m.END_TIME) - Math.max(q.START_TIME, m.START_TIME),
          );
        }
        const expected = (ms / config.MS_PER_CREDIT[m.WAREHOUSE_NAME]) * RATE;
        maxError = Math.max(maxError, Math.abs(m.CREDITS_USED - expected));
      }
      expect(maxError).toBeLessThan(1e-9);
    });

    it('emits unique, hour-aligned rows with compute = used and zero cloud services', () => {
      const malformed = metering.filter(
        (m) =>
          m.START_TIME % HOUR_MS !== 0 ||
          m.END_TIME - m.START_TIME !== HOUR_MS ||
          m.CREDITS_USED !== m.CREDITS_USED_COMPUTE ||
          m.CREDITS_USED_CLOUD_SERVICES !== 0 ||
          !(m.CREDITS_USED > 0),
      );
      expect(malformed).toEqual([]);
      expect(new Set(metering.map((m) => `${m.WAREHOUSE_NAME}|${m.START_TIME}`)).size).toBe(
        metering.length,
      );
    });
  });
});

it('the simulator source never reads the raw (possibly negative) credits column', () => {
  const src = fs.readFileSync(
    path.join(ROOT_DIR, 'server', 'src', 'ingest', 'snowflake-sim.ts'),
    'utf8',
  );
  expect(src).not.toMatch(/snowflake_credits_consumed/);
});
