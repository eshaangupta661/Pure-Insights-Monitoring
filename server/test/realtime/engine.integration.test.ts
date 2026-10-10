import type { Alert } from '@pic/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { AlertEngine } from '../../src/realtime/engine.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';

const N = config.SNAPSHOT_COUNT;
const CYCLE = 5;
const ALL = { kind: 'all' } as const;
const keyOf = (a: Pick<Alert, 'reportId' | 'ruleId'>) => `${a.reportId}|${a.ruleId}`;

/** The alert engine over the real CSV: lifecycle invariants and restart reproducibility. */
describe('AlertEngine on the real snapshots', () => {
  let t: TestApp;
  let stepped: AlertEngine;
  let slowRows: { reportId: string; tick: number }[];

  beforeAll(async () => {
    t = await buildTestApp();
    slowRows = await t.sql<{ reportId: string; tick: number }>(
      `SELECT report_id AS "reportId", snapshot_idx AS tick FROM REPORT_SNAPSHOTS
       WHERE avg_load_time_sec > ${config.LATENCY_WARNING_SEC}`,
    );
    stepped = await AlertEngine.load(t.warehouse);
  });
  afterAll(() => t?.close());

  it('stepping ticks 0..19: at most one active alert per (report, rule) at every tick', () => {
    for (let tick = 0; tick < N; tick++) {
      stepped.syncTo({ cycle: CYCLE, tick });
      const active = stepped.list(ALL).filter((a) => a.status !== 'RESOLVED');
      expect(new Set(active.map(keyOf)).size).toBe(active.length);
    }
  });

  it('per key, alerts never overlap and reopen only after the cooldown', () => {
    const byKey = new Map<string, Alert[]>();
    for (const a of stepped.list(ALL)) byKey.set(keyOf(a), [...(byKey.get(keyOf(a)) ?? []), a]);
    for (const alerts of byKey.values()) {
      alerts.sort((a, b) => a.openedTick - b.openedTick);
      for (let i = 1; i < alerts.length; i++) {
        const prev = alerts[i - 1]!;
        expect(prev.resolvedTick).toBeDefined();
        expect(alerts[i]!.openedTick - prev.resolvedTick!).toBeGreaterThanOrEqual(
          config.ALERT_COOLDOWN_TICKS,
        );
      }
    }
  });

  it('most rows breach 15 s, yet alerts are per episode, not per row', () => {
    const latency = stepped.list(ALL).filter((a) => a.ruleId === 'LATENCY');
    expect(slowRows.length).toBeGreaterThan((N * 100) / 2); // the dataset: ~75% of rows
    expect(latency.length).toBeLessThan(slowRows.length / 2);
  });

  it('no breach goes unalerted: every slow row is inside an alert or a cooldown window', () => {
    const latency = stepped.list(ALL).filter((a) => a.ruleId === 'LATENCY');
    for (const { reportId, tick } of slowRows) {
      const covered = latency.some(
        (a) =>
          a.reportId === reportId &&
          ((a.openedTick <= tick && tick <= (a.resolvedTick ?? N - 1)) ||
            (a.resolvedTick !== undefined &&
              tick > a.resolvedTick &&
              tick < a.resolvedTick + config.ALERT_COOLDOWN_TICKS)),
      );
      expect(covered, `${reportId} at tick ${tick}`).toBe(true);
    }
  });

  it('restart: a fresh engine synced straight to the same position reproduces the state', async () => {
    for (const tick of [9, N - 1]) {
      const reference = await AlertEngine.load(t.warehouse);
      for (let i = 0; i <= tick; i++) reference.syncTo({ cycle: CYCLE, tick: i });
      const restarted = await AlertEngine.load(t.warehouse);
      restarted.syncTo({ cycle: CYCLE, tick });
      expect(restarted.list(ALL)).toEqual(reference.list(ALL));
    }
  });
});
