import type { CostAssumptions, CostProjection, ViewerCostAssumptions } from '@pic/shared';
import type { Agent } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { buildTestApp, LATEST_TICK, type TestApp } from '../helpers/app.js';
import { loginAs } from '../helpers/auth.js';

const OWNER = 'user_3@company.com';
const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

/** GET /costs/projection (/sql/10) and GET /costs/assumptions, per role and replay position. */
describe('cost projection and assumptions', () => {
  let t: TestApp;
  let admin: Agent;
  let owner: Agent;
  let viewer: Agent;

  /** Σ daily attributed Snowflake cost per snapshot, straight from 05, for `where`. */
  const dailyCost = async (where: string) =>
    (
      await t.sql<{ c: number }>(
        `SELECT COALESCE(SUM(u.snowflake_cost_usd), 0) AS c
         FROM UNIT_ECONOMICS_SNAPSHOT u JOIN REPORT_CURRENT_OWNER o ON o.report_id = u.report_id
         WHERE ${where} GROUP BY u.snapshot_idx ORDER BY u.snapshot_idx`,
      )
    ).map((r) => r.c);

  beforeAll(async () => {
    t = await buildTestApp();
    admin = await loginAs(t.app, 'admin');
    owner = await loginAs(t.app, 'owner');
    viewer = await loginAs(t.app, 'viewer');
  }, 60_000);
  afterAll(() => t.close());

  describe('GET /costs/projection', () => {
    it('at the last snapshot: every point replayed, no holdout, month-end = to date + run rate × rest', async () => {
      const res = await admin.get('/api/v1/costs/projection');
      expect(res.status).toBe(200);
      const p: CostProjection = res.body;
      expect(p.currentIdx).toBe(LATEST_TICK);
      expect(p.totals.points).toHaveLength(config.SNAPSHOT_COUNT);
      expect(p.totals.points.every((x) => x.replayed && x.forecastLowUsd === null)).toBe(true);
      expect(p.holdoutCount).toBe(0);
      expect(p.mape).toBeNull();

      const daily = await dailyCost('TRUE');
      expect(p.totals.points.map((x) => x.actualCostUsd)).toEqual(
        daily.map((c) => expect.closeTo(c, 6)),
      );
      expect(p.totals.costToDateUsd).toBeCloseTo(sum(daily), 4);
      expect(p.daysPerMonth).toBe(config.DAYS_PER_MONTH);
      expect(p.remainingDays).toBe(config.DAYS_PER_MONTH - config.SNAPSHOT_COUNT);
      expect(p.totals.runRateUsdPerDay).toBeCloseTo(sum(daily) / config.SNAPSHOT_COUNT, 6);
      expect(p.totals.projectedMonthEndUsd).toBeCloseTo(
        p.totals.costToDateUsd + p.totals.runRateUsdPerDay! * p.remainingDays,
        4,
      );
    });

    it('mid-replay: fits 0..N only, forecasts N+1.. with a band, scores MAPE on the rest', async () => {
      t.clock.set(5);
      try {
        const p: CostProjection = (await admin.get('/api/v1/costs/projection')).body;
        expect(p.currentIdx).toBe(5);
        expect(p.totals.fit.pointCount).toBe(6);
        expect(p.holdoutCount).toBe(config.SNAPSHOT_COUNT - 6);
        expect(p.totals.points.filter((x) => x.replayed)).toHaveLength(6);
        const after = p.totals.points.filter((x) => !x.replayed);
        for (const x of after) {
          expect(x.forecastLowUsd!).toBeLessThan(x.trendCostUsd!);
          expect(x.forecastHighUsd!).toBeGreaterThan(x.trendCostUsd!);
          expect(x.trendCostUsd!).toBeCloseTo(
            p.totals.fit.interceptUsd! + p.totals.fit.slopeUsdPerDay! * x.snapshotIdx,
            6,
          );
        }
        // MAPE recomputed from the points it was scored on.
        const mape =
          sum(after.map((x) => Math.abs(x.actualCostUsd - x.trendCostUsd!) / x.actualCostUsd)) /
          after.length;
        expect(p.mape).toBeCloseTo(mape, 10);
        // Cost to date covers 0..N only.
        const daily = await dailyCost('TRUE');
        expect(p.totals.costToDateUsd).toBeCloseTo(sum(daily.slice(0, 6)), 4);
      } finally {
        t.clock.set(LATEST_TICK);
      }
    });

    it('at snapshot 0: one point, no line, no band', async () => {
      t.clock.set(0);
      try {
        const p: CostProjection = (await admin.get('/api/v1/costs/projection')).body;
        expect(p.totals.fit).toMatchObject({ pointCount: 1, slopeUsdPerDay: null });
        expect(p.totals.points.every((x) => x.trendCostUsd === null)).toBe(true);
        expect(p.mape).toBeNull();
        expect(p.totals.projectedMonthEndUsd).toBeGreaterThan(0);
      } finally {
        t.clock.set(LATEST_TICK);
      }
    });

    it('owners get their own reports only (scoped in SQL)', async () => {
      const p: CostProjection = (await owner.get('/api/v1/costs/projection')).body;
      const mine = await dailyCost(`o.current_owner = '${OWNER}'`);
      expect(p.totals.points.map((x) => x.actualCostUsd)).toEqual(
        mine.map((c) => expect.closeTo(c, 6)),
      );
      const all: CostProjection = (await admin.get('/api/v1/costs/projection')).body;
      expect(p.totals.costToDateUsd).toBeLessThan(all.totals.costToDateUsd);
    });

    it('viewers get the same aggregates as admins', async () => {
      const v = (await viewer.get('/api/v1/costs/projection')).body;
      const a = (await admin.get('/api/v1/costs/projection')).body;
      expect(v).toEqual(a);
    });
  });

  describe('GET /costs/assumptions', () => {
    it('returns PARAMS as config.ts has them', async () => {
      const a: CostAssumptions = (await admin.get('/api/v1/costs/assumptions')).body;
      expect(a.params).toEqual({
        creditPriceUsd: config.CREDIT_PRICE_USD,
        simulatedOverheadRate: config.SIMULATED_OVERHEAD_RATE,
        snapshotDays: config.SNAPSHOT_DAYS,
        daysPerMonth: config.DAYS_PER_MONTH,
        costLowViews: config.COST_LOW_VIEWS,
        costHighAwsUsd: config.COST_HIGH_AWS_USD,
        costRobustZ: config.COST_ROBUST_Z,
      });
      expect(a.snapshotIdx).toBe(LATEST_TICK);
    });

    it('the worked example is internally consistent from warehouse hour to unit cost', async () => {
      const { example: e, params } = (await admin.get('/api/v1/costs/assumptions'))
        .body as CostAssumptions;
      expect(e).not.toBeNull();
      const q = e!.queryHour!;
      expect(q.attributedCredits).toBeCloseTo(
        (q.hourMeteredCredits * q.execMsInHour) / q.hourExecMs,
        9,
      );
      expect(e!.activeCredits + e!.overheadCredits).toBeCloseTo(e!.attributedCredits, 9);
      expect(e!.activeCredits * (1 + params.simulatedOverheadRate)).toBeCloseTo(
        e!.attributedCredits,
        9,
      );
      expect(e!.snowflakeCostUsd).toBeCloseTo(e!.attributedCredits * params.creditPriceUsd, 6);
      expect(e!.snowflakeCost30dUsd).toBeCloseTo(e!.snowflakeCostUsd * params.daysPerMonth, 6);
      expect(e!.fullyLoadedCostUsd).toBeCloseTo(e!.snowflakeCost30dUsd + e!.awsCostUsd, 6);
      expect(e!.fullyLoadedCostPerView).toBeCloseTo(e!.fullyLoadedCostUsd / e!.views, 9);
      // The most expensive report at this snapshot.
      const [top] = await t.sql<{ report_id: string }>(
        `SELECT report_id FROM UNIT_ECONOMICS_SNAPSHOT
         WHERE snapshot_idx = ${LATEST_TICK} AND views > 0 AND attributed_credits > 0
         ORDER BY snowflake_cost_usd DESC, report_id LIMIT 1`,
      );
      expect(e!.reportId).toBe(top!.report_id);
    });

    it('owners get an example from their own reports', async () => {
      const a: CostAssumptions = (await owner.get('/api/v1/costs/assumptions')).body;
      expect(a.example?.currentOwner).toBe(OWNER);
    });

    it('viewers get the parameters but no per-report example', async () => {
      const v: ViewerCostAssumptions = (await viewer.get('/api/v1/costs/assumptions')).body;
      expect(v.params.creditPriceUsd).toBe(config.CREDIT_PRICE_USD);
      expect(v).not.toHaveProperty('example');
    });
  });
});
