import type { ReplayState } from '@pic/shared';
import { config } from '../config.js';

/** Deterministic tick from wall-clock time: floor((now + offset) / TICK_MS) % SNAPSHOT_COUNT. */
export function currentTick(now: number = Date.now(), offsetMs = 0): number {
  return Math.floor((now + offsetMs) / config.TICK_MS) % config.SNAPSHOT_COUNT;
}

/** Snapshot i is the UTC day SNAPSHOT_BASE_DATE + i (an assumption; the CSV has no dates). */
export function snapshotDateFor(snapshotIdx: number): string {
  const base = Date.parse(`${config.SNAPSHOT_BASE_DATE}T00:00:00Z`);
  return new Date(base + snapshotIdx * 86_400_000).toISOString().slice(0, 10);
}

export interface ClockState {
  anchorReal: number;
  anchorVirtual: number;
  speed: number;
  paused: boolean;
}

/** Where the replay is: `tick` within the current pass over the snapshots, `cycle` = passes so far. */
export interface ReplayPosition {
  tick: number;
  cycle: number;
}

/**
 * The replay clock. Ticks are derived from virtual time, never counted:
 *
 *   virtualNow = paused ? anchorVirtual : anchorVirtual + (now − anchorReal) × speed
 *   absolute   = floor(virtualNow / TICK_MS);  tick = absolute % 20;  cycle = floor(absolute / 20)
 *
 * It starts with virtual = wall time (so tick = currentTick() at speed 1). Pause, resume and
 * speed changes only move the anchors (the generalized "offset"), so virtual time never jumps
 * and the tick continues from where it was. Restart-safe in the same sense as the offset: a
 * restart forgets pause/speed and resumes from wall time.
 */
export class ReplayClock {
  private anchorReal: number;
  private anchorVirtual: number;
  private speed = 1;
  private paused = false;

  constructor(private readonly now: () => number = Date.now) {
    this.anchorReal = this.anchorVirtual = now();
  }

  virtualNow(): number {
    if (this.paused) return this.anchorVirtual;
    return this.anchorVirtual + (this.now() - this.anchorReal) * this.speed;
  }

  position(): ReplayPosition {
    const absolute = Math.floor(this.virtualNow() / config.TICK_MS);
    return {
      tick: absolute % config.SNAPSHOT_COUNT,
      cycle: Math.floor(absolute / config.SNAPSHOT_COUNT),
    };
  }

  tick(): number {
    return this.position().tick;
  }

  /** Wall-clock ms until the next tick boundary at the current speed; null while paused. */
  msUntilNextTick(): number | null {
    if (this.paused) return null;
    const into = ((this.virtualNow() % config.TICK_MS) + config.TICK_MS) % config.TICK_MS;
    return (config.TICK_MS - into) / this.speed;
  }

  /** Virtual epoch ms at which `position` began; used as a deterministic alert openedAt. */
  static startOf({ tick, cycle }: ReplayPosition): number {
    return (cycle * config.SNAPSHOT_COUNT + tick) * config.TICK_MS;
  }

  pause(): void {
    if (this.paused) return;
    this.reanchor();
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.anchorReal = this.now(); // anchorVirtual already holds the frozen time
    this.paused = false;
  }

  /**
   * Skips forward to the last snapshot of the current pass and pauses there. Only moves virtual
   * time forward (a no-op move when already on the last snapshot), so the cycle never changes.
   */
  jumpToEnd(): void {
    const { cycle } = this.position();
    const absolute = cycle * config.SNAPSHOT_COUNT + (config.SNAPSHOT_COUNT - 1);
    this.anchorVirtual = Math.max(this.virtualNow(), absolute * config.TICK_MS);
    this.anchorReal = this.now();
    this.paused = true;
  }

  setSpeed(speed: number): void {
    if (!(speed > 0)) throw new RangeError(`speed must be > 0, got ${speed}`);
    this.reanchor();
    this.speed = speed;
  }

  state(): ReplayState {
    const { tick, cycle } = this.position();
    return {
      tick,
      cycle,
      snapshotDate: snapshotDateFor(tick),
      paused: this.paused,
      speed: this.speed,
      speeds: [...config.REPLAY_SPEEDS],
      tickMs: config.TICK_MS,
    };
  }

  /** Everything that defines the clock, for undoing a replay command (see routes/admin.ts). */
  save(): ClockState {
    return {
      anchorReal: this.anchorReal,
      anchorVirtual: this.anchorVirtual,
      speed: this.speed,
      paused: this.paused,
    };
  }

  /** Puts the clock back on the timeline it had at save(), as if the command never happened. */
  restore(saved: ClockState): void {
    this.anchorReal = saved.anchorReal;
    this.anchorVirtual = saved.anchorVirtual;
    this.speed = saved.speed;
    this.paused = saved.paused;
  }

  private reanchor(): void {
    this.anchorVirtual = this.virtualNow();
    this.anchorReal = this.now();
  }
}
