import { config } from '../config.js';

/** Deterministic replay tick. No in-memory counter; pause/speed (Phase 4) will only change the offset. */
export function currentTick(now: number = Date.now(), offsetMs = 0): number {
  return Math.floor((now + offsetMs) / config.TICK_MS) % config.SNAPSHOT_COUNT;
}
