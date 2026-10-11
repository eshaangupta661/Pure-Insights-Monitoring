import { describe, expect, it } from 'vitest';
import { bucketLatencies } from '../../src/repos/overview.js';

describe('bucketLatencies', () => {
  it('puts a value on an edge into the bucket that starts there', () => {
    const b = bucketLatencies([0.6, 4.9, 5, 14.99, 15, 55], [5, 15]);
    expect(b).toEqual([
      { lowerSec: 0, upperSec: 5, count: 2 },
      { lowerSec: 5, upperSec: 15, count: 2 },
      { lowerSec: 15, upperSec: null, count: 2 },
    ]);
  });

  it('returns empty buckets for no data', () => {
    expect(bucketLatencies([], [10]).map((x) => x.count)).toEqual([0, 0]);
  });
});
