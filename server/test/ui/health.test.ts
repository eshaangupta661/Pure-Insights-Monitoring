import type { HealthRing, SystemHealth } from '@pic/shared';
import { describe, expect, it } from 'vitest';
import { changePoints, formatChange, weakestRing } from '../../../client/src/lib/health.js';

const ring = (rate: number | null, previousRate: number | null = null): HealthRing => ({
  count: 0,
  total: 0,
  rate,
  previousRate,
});
const health = (r: number | null, l: number | null, o: number | null): SystemHealth => ({
  refresh: ring(r),
  latency: ring(l),
  ownership: ring(o),
});

describe('system health helpers', () => {
  it('picks the lowest rate, first in order on a tie, skipping null', () => {
    expect(weakestRing(health(0.7, 0.2, 0.9))).toBe('latency');
    expect(weakestRing(health(0.5, 0.5, 0.9))).toBe('refresh');
    expect(weakestRing(health(null, 0.8, null))).toBe('latency');
    expect(weakestRing(health(null, null, null))).toBeNull();
  });

  it('reports change in percentage points to one decimal', () => {
    expect(changePoints(ring(0.65, 0.6))).toBe(5);
    expect(changePoints(ring(0.55, 0.6))).toBe(-5);
    expect(changePoints(ring(0.6, null))).toBeNull();
    expect(changePoints(ring(null, 0.6))).toBeNull();
  });

  it('formats the change as text, never colour alone', () => {
    expect(formatChange(2.5)).toBe('+2.5 pp');
    expect(formatChange(-1)).toBe('−1.0 pp');
    expect(formatChange(0)).toBe('no change');
    expect(formatChange(null)).toBe('no earlier snapshot to compare');
  });
});
