import type { RefreshStatus } from '@pic/shared';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { AlertStore } from '../../src/realtime/alertStore.js';
import { ReplayClock, currentTick } from '../../src/realtime/clock.js';
import { AlertEngine, IncidentLimitError } from '../../src/realtime/engine.js';
import { evaluateReading, type Reading } from '../../src/realtime/rules.js';

const TICK = config.TICK_MS;
const N = config.SNAPSHOT_COUNT;

const reading = (over: Partial<Reading> = {}): Reading => ({
  reportId: 'RPT_1',
  reportName: 'Report 1',
  refreshStatus: 'SUCCESS',
  loadTimeSec: 5,
  synthetic: false,
  ...over,
});
const slow = (loadTimeSec: number) => reading({ loadTimeSec });
const healthy = reading();

describe('ReplayClock', () => {
  const at = (ms: number) => {
    let now = ms;
    return { clock: new ReplayClock(() => now), move: (d: number) => void (now += d) };
  };

  it('starts at wall time: same tick as currentTick(); cycle = passes over 20 snapshots', () => {
    const start = (7 * N + 3) * TICK + 5;
    const { clock } = at(start);
    expect(clock.position()).toEqual({ tick: 3, cycle: 7 });
    expect(clock.tick()).toBe(currentTick(start));
  });

  it('advances one tick per TICK_MS and wraps 19 → 0 into the next cycle', () => {
    const { clock, move } = at((7 * N + 19) * TICK);
    move(TICK);
    expect(clock.position()).toEqual({ tick: 0, cycle: 8 });
  });

  it('pause freezes the tick; resume continues from the same point, no jump', () => {
    const { clock, move } = at(3 * TICK + TICK / 2);
    clock.pause();
    move(10 * TICK);
    expect(clock.tick()).toBe(3);
    expect(clock.state().paused).toBe(true);
    clock.resume();
    expect(clock.tick()).toBe(3);
    move(TICK / 2);
    expect(clock.tick()).toBe(4);
  });

  it('speed scales elapsed time from the moment it changes, without jumping', () => {
    const { clock, move } = at(3 * TICK + TICK / 2);
    clock.setSpeed(10);
    expect(clock.tick()).toBe(3);
    move(TICK / 20); // 0.05 tick of wall time = 0.5 tick of replay time
    expect(clock.tick()).toBe(4);
    clock.setSpeed(1);
    move(TICK / 2);
    expect(clock.tick()).toBe(4);
    expect(() => clock.setSpeed(0)).toThrow(RangeError);
  });

  it('restore() undoes a command: the clock continues on its original timeline', () => {
    const { clock, move } = at(3 * TICK);
    const saved = clock.save();
    clock.pause();
    clock.setSpeed(10);
    move(2 * TICK);
    clock.restore(saved);
    expect(clock.state()).toMatchObject({ tick: 5, paused: false, speed: 1 });
  });

  it('pause/resume are idempotent', () => {
    const { clock, move } = at(2 * TICK);
    clock.resume();
    clock.pause();
    clock.pause();
    move(5 * TICK);
    clock.resume();
    clock.resume();
    expect(clock.tick()).toBe(2);
  });
});

describe('alert rules', () => {
  it.each([
    [15, []],
    [15.01, [['LATENCY', 'WARNING', 15]]],
    [30, [['LATENCY', 'WARNING', 15]]],
    [30.01, [['LATENCY', 'CRITICAL', 30]]],
  ])('latency %s s → %j (strictly greater than the threshold)', (sec, expected) => {
    expect(evaluateReading(slow(sec)).map((v) => [v.ruleId, v.severity, v.threshold])).toEqual(
      expected,
    );
  });

  it.each<[RefreshStatus, string[]]>([
    ['SUCCESS', []],
    ['FAILED', ['REFRESH_FAILED:CRITICAL']],
    ['TIMED_OUT', ['REFRESH_FAILED:CRITICAL']],
    ['UNKNOWN', ['REFRESH_UNKNOWN:INFO']],
  ])('refresh %s → %j', (status, expected) => {
    expect(
      evaluateReading(reading({ refreshStatus: status })).map((v) => `${v.ruleId}:${v.severity}`),
    ).toEqual(expected);
  });

  it('a slow failed refresh violates two rules', () => {
    expect(
      evaluateReading(reading({ loadTimeSec: 40, refreshStatus: 'FAILED' })).map((v) => v.ruleId),
    ).toEqual(['LATENCY', 'REFRESH_FAILED']);
  });
});

describe('AlertStore lifecycle', () => {
  /** Applies `readings[t]` for t = 0, 1, ...; returns the store. */
  const run = (readings: Reading[]) => {
    const store = new AlertStore(0);
    const events = readings.map((r, t) => store.applyTick(t, [r]));
    return { store, events, latency: () => store.all().filter((a) => a.ruleId === 'LATENCY') };
  };

  it('opens once per key and does not re-fire while OPEN', () => {
    const { latency, events } = run([slow(20), slow(21), slow(22)]);
    expect(latency()).toHaveLength(1);
    expect(latency()[0]).toMatchObject({
      id: '0-RPT_1-LATENCY-0',
      status: 'OPEN',
      openedTick: 0,
      lastSeenTick: 2,
      value: 22,
    });
    expect(events.map((e) => e.opened.length)).toEqual([1, 0, 0]);
  });

  it('escalates WARNING → CRITICAL (same alert, updated event); never de-escalates', () => {
    const { latency, events } = run([slow(20), slow(40), slow(20)]);
    expect(latency()).toHaveLength(1);
    // value/message keep the peak, consistent with the CRITICAL threshold
    expect(latency()[0]).toMatchObject({
      severity: 'CRITICAL',
      threshold: 30,
      value: 40,
      message: 'Load time 40s > 30s',
    });
    expect(events[1]!.updated).toEqual([expect.objectContaining({ severity: 'CRITICAL' })]);
    expect(events[2]!.updated).toEqual([]);
  });

  it(`auto-resolves after ${config.ALERT_AUTO_RESOLVE_TICKS} consecutive healthy ticks, not 1`, () => {
    const { latency, events } = run([slow(20), healthy, slow(20), healthy, healthy]);
    expect(latency()).toHaveLength(1); // the blip at t=2 reset the streak, no new alert
    expect(latency()[0]).toMatchObject({ status: 'RESOLVED', resolvedTick: 4 });
    expect(events[4]!.updated).toEqual([expect.objectContaining({ status: 'RESOLVED' })]);
  });

  it(`cooldown: the key can reopen only ${config.ALERT_COOLDOWN_TICKS} ticks after resolving`, () => {
    // resolves at t=2; violations at t=3 and t=4 are in cooldown; t=5 reopens
    const { latency } = run([slow(20), healthy, healthy, slow(20), slow(20), slow(20)]);
    expect(latency().map((a) => [a.id, a.status])).toEqual([
      ['0-RPT_1-LATENCY-0', 'RESOLVED'],
      ['0-RPT_1-LATENCY-5', 'OPEN'],
    ]);
  });

  it('a synthetic (incident) reading bypasses the cooldown', () => {
    const { latency } = run([
      slow(20),
      healthy,
      healthy,
      reading({ loadTimeSec: 45, synthetic: true }),
    ]);
    expect(latency().at(-1)).toMatchObject({
      openedTick: 3,
      synthetic: true,
      severity: 'CRITICAL',
    });
  });

  it('escalating an ACKNOWLEDGED alert emits an updated event and stays ACKNOWLEDGED', () => {
    const store = new AlertStore(0);
    store.applyTick(0, [slow(20)]);
    const id = '0-RPT_1-LATENCY-0';
    store.ack(id, 'a@x');
    const events = store.applyTick(1, [slow(40)]);
    expect(events.opened).toEqual([]);
    expect(events.updated).toEqual([
      expect.objectContaining({
        id,
        status: 'ACKNOWLEDGED',
        ackedBy: 'a@x',
        severity: 'CRITICAL',
        threshold: 30,
        value: 40,
      }),
    ]);
    // A further CRITICAL reading is not an escalation: no event.
    expect(store.applyTick(2, [slow(45)]).updated).toEqual([]);
  });

  it('ack: OPEN → ACKNOWLEDGED, idempotent, refused once RESOLVED; acked alerts still resolve', () => {
    const store = new AlertStore(0);
    store.applyTick(0, [slow(20)]);
    const id = '0-RPT_1-LATENCY-0';
    expect(store.ack(id, 'a@x')).toMatchObject({
      ok: true,
      changed: true,
      alert: { status: 'ACKNOWLEDGED', ackedBy: 'a@x' },
    });
    expect(store.ack(id, 'b@x')).toMatchObject({
      ok: true,
      changed: false,
      alert: { ackedBy: 'a@x' },
    });
    store.applyTick(1, [slow(40)]);
    expect(store.get(id)).toMatchObject({ status: 'ACKNOWLEDGED', severity: 'CRITICAL' });
    store.applyTick(2, [healthy]);
    store.applyTick(3, [healthy]);
    expect(store.get(id)?.status).toBe('RESOLVED');
    expect(store.ack(id, 'a@x')).toEqual({ ok: false, reason: 'RESOLVED' });
    expect(store.ack('nope', 'a@x')).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('keys are independent per (report, rule)', () => {
    const store = new AlertStore(0);
    store.applyTick(0, [
      reading({ loadTimeSec: 40, refreshStatus: 'FAILED' }),
      reading({ reportId: 'RPT_2', refreshStatus: 'UNKNOWN' }),
    ]);
    expect(
      store
        .all()
        .map((a) => a.id)
        .sort(),
    ).toEqual(['0-RPT_1-LATENCY-0', '0-RPT_1-REFRESH_FAILED-0', '0-RPT_2-REFRESH_UNKNOWN-0']);
  });
});

describe('AlertEngine', () => {
  // Two reports over 20 snapshots: RPT_1 slow on ticks 2–4 and 10–12, RPT_2 failing on 5–6.
  const byTick: Reading[][] = Array.from({ length: N }, (_, t) => [
    reading({ loadTimeSec: (t >= 2 && t <= 4) || (t >= 10 && t <= 12) ? 20 : 5 }),
    reading({
      reportId: 'RPT_2',
      reportName: 'Report 2',
      refreshStatus: t === 5 || t === 6 ? 'FAILED' : 'SUCCESS',
    }),
  ]);
  const owners = () =>
    new Map<string, string | null>([
      ['RPT_1', 'a@x.com'],
      ['RPT_2', 'b@x.com'],
    ]);
  const ALL = { kind: 'all' } as const;
  const admin = { email: 'admin@x.com', role: 'admin' } as const;
  const make = () => new AlertEngine(byTick, owners());

  it('incremental syncing equals a rebuild from scratch', () => {
    const stepped = make();
    for (let t = 0; t < N; t++) stepped.syncTo({ cycle: 3, tick: t });
    const rebuilt = make();
    rebuilt.syncTo({ cycle: 3, tick: N - 1 });
    expect(stepped.list(ALL)).toEqual(rebuilt.list(ALL));
    expect(rebuilt.list(ALL).map((a) => a.id)).toEqual(
      expect.arrayContaining([
        '3-RPT_1-LATENCY-2',
        '3-RPT_1-LATENCY-10',
        '3-RPT_2-REFRESH_FAILED-5',
      ]),
    );
  });

  it('a repeated syncTo at the same tick is a no-op', () => {
    const engine = make();
    engine.syncTo({ cycle: 3, tick: 2 });
    const before = engine.list(ALL);
    expect(engine.syncTo({ cycle: 3, tick: 2 })).toEqual({
      opened: [],
      updated: [],
      rebuilt: false,
    });
    expect(engine.list(ALL)).toEqual(before);
  });

  it('reports opened and updated alerts per step', () => {
    const engine = make();
    engine.syncTo({ cycle: 3, tick: 1 });
    const step = engine.syncTo({ cycle: 3, tick: 2 });
    expect(step.opened.map((a) => [a.id, a.ownerEmail])).toEqual([
      ['3-RPT_1-LATENCY-2', 'a@x.com'],
    ]);
    const resolved = engine.syncTo({ cycle: 3, tick: 6 });
    expect(resolved.updated).toEqual([
      expect.objectContaining({ id: '3-RPT_1-LATENCY-2', status: 'RESOLVED' }),
    ]);
  });

  it('an ack survives a rebuild', () => {
    const engine = make();
    engine.syncTo({ cycle: 3, tick: 3 });
    expect(engine.ack('3-RPT_1-LATENCY-2', admin, ALL)).toMatchObject({ ok: true, changed: true });
    engine.rebuild({ cycle: 3, tick: 3 });
    engine.syncTo({ cycle: 3, tick: 4 });
    expect(engine.list(ALL).find((a) => a.id === '3-RPT_1-LATENCY-2')).toMatchObject({
      status: 'ACKNOWLEDGED',
      ackedBy: 'admin@x.com',
    });
  });

  it('an incident survives a rebuild', () => {
    const engine = make();
    engine.syncTo({ cycle: 3, tick: 8 });
    const { alert, events } = engine.injectIncident('RPT_2', 'LATENCY_SPIKE');
    expect(alert).toMatchObject({
      id: '3-RPT_2-LATENCY-8',
      synthetic: true,
      severity: 'CRITICAL',
      ownerEmail: 'b@x.com',
    });
    expect(events.opened.map((a) => a.id)).toEqual(['3-RPT_2-LATENCY-8']);
    engine.rebuild({ cycle: 3, tick: 8 });
    expect(engine.list(ALL).find((a) => a.id === '3-RPT_2-LATENCY-8')).toMatchObject({
      synthetic: true,
    });
  });

  it('reassigning an owner moves their open alerts (owner resolved at read time)', async () => {
    const engine = make();
    engine.syncTo({ cycle: 3, tick: 3 });
    const a = { kind: 'owner', email: 'a@x.com' } as const;
    const b = { kind: 'owner', email: 'b@x.com' } as const;
    expect(engine.list(a).map((x) => x.reportId)).toEqual(['RPT_1']);
    expect(engine.list(b)).toEqual([]);
    await engine.refreshOwners({
      query: async <T>() =>
        [
          { reportId: 'RPT_1', owner: 'b@x.com' },
          { reportId: 'RPT_2', owner: 'b@x.com' },
        ] as T[],
      run: async () => {},
    });
    expect(engine.list(a)).toEqual([]);
    expect(engine.list(b).map((x) => [x.reportId, x.ownerEmail])).toEqual([['RPT_1', 'b@x.com']]);
    // and the new owner may now ack it; the old one gets NOT_FOUND
    expect(engine.ack('3-RPT_1-LATENCY-2', { email: 'a@x.com', role: 'owner' }, a)).toEqual({
      ok: false,
      reason: 'NOT_FOUND',
    });
    expect(engine.ack('3-RPT_1-LATENCY-2', { email: 'b@x.com', role: 'owner' }, b)).toMatchObject({
      ok: true,
    });
  });

  it('counts active alerts by severity in scope', () => {
    const engine = make();
    engine.syncTo({ cycle: 3, tick: 5 });
    expect(engine.counts(ALL)).toEqual({
      total: 2,
      open: 2,
      acknowledged: 0,
      INFO: 0,
      WARNING: 1,
      CRITICAL: 1,
    });
    expect(engine.counts({ kind: 'owner', email: 'b@x.com' })).toMatchObject({
      total: 1,
      CRITICAL: 1,
    });
  });

  it('withdrawAck undoes an ack (used when its audit row cannot be written)', () => {
    const engine = make();
    engine.syncTo({ cycle: 3, tick: 3 });
    const result = engine.ack('3-RPT_1-LATENCY-2', admin, ALL);
    expect(result).toMatchObject({ ok: true, changed: true });
    if (!result.ok || !result.record) throw new Error('expected a new ack');
    engine.withdrawAck(result.record);
    expect(engine.list(ALL).find((a) => a.id === '3-RPT_1-LATENCY-2')).toMatchObject({
      status: 'OPEN',
    });
    // and it stays withdrawn across a rebuild
    engine.rebuild({ cycle: 3, tick: 3 });
    expect(engine.list(ALL).find((a) => a.id === '3-RPT_1-LATENCY-2')?.status).toBe('OPEN');
    // a repeat ack of an already acked alert records nothing to undo
    engine.ack('3-RPT_1-LATENCY-2', admin, ALL);
    expect(engine.ack('3-RPT_1-LATENCY-2', admin, ALL)).toMatchObject({
      changed: false,
      record: null,
    });
  });

  it('withdrawIncident undoes an incident', () => {
    const engine = make();
    engine.syncTo({ cycle: 3, tick: 8 });
    const { incident } = engine.injectIncident('RPT_2', 'LATENCY_SPIKE');
    engine.withdrawIncident(incident!);
    expect(engine.list(ALL).some((a) => a.id === '3-RPT_2-LATENCY-8')).toBe(false);
  });

  it('identical incidents at the same tick are deduplicated; distinct ones are capped', () => {
    const engine = new AlertEngine(byTick, owners(), 3);
    engine.syncTo({ cycle: 3, tick: 8 });
    const first = engine.injectIncident('RPT_2', 'LATENCY_SPIKE');
    const repeat = engine.injectIncident('RPT_2', 'LATENCY_SPIKE');
    expect(first.incident).not.toBeNull();
    expect(repeat).toMatchObject({ incident: null, alert: { id: first.alert.id } });
    expect(repeat.events).toEqual({ opened: [], updated: [], rebuilt: false });
    engine.injectIncident('RPT_2', 'REFRESH_FAILED');
    engine.injectIncident('RPT_1', 'REFRESH_FAILED');
    expect(() => engine.injectIncident('RPT_1', 'LATENCY_SPIKE')).toThrow(IncidentLimitError);
    // still a no-op (not an error) to repeat one that exists
    expect(engine.injectIncident('RPT_2', 'LATENCY_SPIKE').incident).toBeNull();
    // the cap is per cycle
    engine.syncTo({ cycle: 4, tick: 8 });
    expect(engine.injectIncident('RPT_1', 'LATENCY_SPIKE').incident).not.toBeNull();
  });

  it('known limitation: acks and incidents reset when the replay wraps to snapshot 0', () => {
    const engine = make();
    engine.syncTo({ cycle: 3, tick: 3 });
    engine.ack('3-RPT_1-LATENCY-2', admin, ALL);
    engine.injectIncident('RPT_2', 'REFRESH_FAILED');
    engine.syncTo({ cycle: 4, tick: 3 });
    const alerts = engine.list(ALL);
    expect(alerts.map((a) => a.id)).toEqual(['4-RPT_1-LATENCY-2']);
    expect(alerts[0]!.status).toBe('OPEN');
  });
});
