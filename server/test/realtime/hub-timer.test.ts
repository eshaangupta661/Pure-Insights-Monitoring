import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config.js';
import type { Queryable } from '../../src/data/warehouse.js';
import { ReplayClock } from '../../src/realtime/clock.js';
import { AlertEngine } from '../../src/realtime/engine.js';
import { RealtimeHub } from '../../src/realtime/hub.js';
import type { Reading } from '../../src/realtime/rules.js';

const TICK = config.TICK_MS;
const N = config.SNAPSHOT_COUNT;
const admin = { email: 'admin@x.com', role: 'admin' } as const;

/** No warehouse needed: the timer path only touches it for audit rows (accepted) and owners. */
const fakeDb: Queryable = { query: async <T>() => [] as T[], run: async () => {} };

function makeHub() {
  const readings: Reading[][] = Array.from({ length: N }, () => [
    {
      reportId: 'RPT_1',
      reportName: 'Report 1',
      refreshStatus: 'SUCCESS',
      loadTimeSec: 5,
      synthetic: false,
    },
  ]);
  // Built after vi.useFakeTimers(), so Date.now is the fake clock.
  const clock = new ReplayClock(() => Date.now());
  const engine = new AlertEngine(readings, new Map([['RPT_1', 'a@x.com']]));
  const hub = new RealtimeHub(fakeDb, clock, engine);
  return { hub, engine, sync: vi.spyOn(hub, 'sync') };
}

describe('RealtimeHub timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10 * TICK + TICK / 2); // halfway through a tick
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('syncs once at each tick boundary, not before', async () => {
    const { hub, sync } = makeHub();
    hub.start();
    await vi.advanceTimersByTimeAsync(TICK / 2 - 10);
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(sync).toHaveBeenCalledTimes(2);
    hub.stop();
  });

  it('a rejected sync is logged and the next tick still fires', async () => {
    const { hub, sync } = makeHub();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('boom');
    sync.mockRejectedValueOnce(boom);
    hub.start();
    await vi.advanceTimersByTimeAsync(TICK / 2 + 10);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('sync failed'), boom);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(sync).toHaveBeenCalledTimes(2);
    hub.stop();
  });

  it('after stop(), nothing reschedules, even if a sync was in flight', async () => {
    const { hub, engine, sync } = makeHub();
    let release: (engine: AlertEngine) => void = () => {};
    sync.mockImplementationOnce(() => new Promise<AlertEngine>((resolve) => (release = resolve)));
    hub.start();
    await vi.advanceTimersByTimeAsync(TICK / 2 + 10);
    expect(sync).toHaveBeenCalledTimes(1);
    hub.stop();
    release(engine); // the in-flight sync settles after stop()
    await vi.advanceTimersByTimeAsync(5 * TICK);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('no timer while paused; resume re-arms it', async () => {
    const { hub, sync } = makeHub();
    hub.start();
    await hub.replay(admin, { action: 'pause' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3 * TICK);
    expect(sync).not.toHaveBeenCalled();
    await hub.replay(admin, { action: 'resume' });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(sync).toHaveBeenCalledTimes(1);
    hub.stop();
  });

  it('a speed change re-arms the timer for the new boundary', async () => {
    const { hub, sync } = makeHub();
    hub.start();
    await hub.replay(admin, { action: 'speed', value: 10 });
    // Half a tick of replay time is left: at 10× that is TICK / 20 of wall time.
    await vi.advanceTimersByTimeAsync(TICK / 20 + 10);
    expect(sync).toHaveBeenCalledTimes(1);
    hub.stop();
  });
});
