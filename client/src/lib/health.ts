import type { HealthRing, SystemHealth } from '@pic/shared';

export type HealthKey = keyof SystemHealth;

/** The weakest ring (lowest rate; ties go to the first in `order`). null when no ring has a rate. */
export function weakestRing(
  health: SystemHealth,
  order: readonly HealthKey[] = ['refresh', 'latency', 'ownership'],
): HealthKey | null {
  let weakest: HealthKey | null = null;
  for (const key of order) {
    const rate = health[key].rate;
    if (rate === null) continue;
    if (weakest === null || rate < (health[weakest].rate ?? Infinity)) weakest = key;
  }
  return weakest;
}

/** Change in percentage points vs the previous snapshot, to one decimal; null with no earlier one. */
export function changePoints(ring: HealthRing): number | null {
  if (ring.rate === null || ring.previousRate === null) return null;
  return Math.round((ring.rate - ring.previousRate) * 1000) / 10;
}

export function formatChange(points: number | null): string {
  if (points === null) return 'no earlier snapshot to compare';
  if (points === 0) return 'no change';
  return `${points > 0 ? '+' : '−'}${Math.abs(points).toFixed(1)} pp`;
}
