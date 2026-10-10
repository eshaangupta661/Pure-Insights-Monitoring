import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import type { SnapshotRow } from '../../src/ingest/normalize.js';
import {
  DQ_RULES,
  computeCostStats,
  flagRow,
  hasImpossibleConcurrency,
  hasNegativeCredits,
  hasZeroViews,
  isCostMismatch,
  isOrphanedOwner,
  isSlowButHealthy,
  isSlowLoad,
  isUnknownRefresh,
  latencySeverity,
  logCostPerView,
  ownerChanged,
  resolveCurrentOwner,
  robustZ,
  type CostStats,
} from '../../src/ingest/rules.js';

function row(overrides: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    row_idx: 0,
    snapshot_idx: 0,
    snapshot_date: '2026-09-21',
    report_id: 'RPT_200',
    report_name: 'Analytics Dashboard 1',
    owner_raw: 'user_1@company.com',
    owner_email: 'user_1@company.com',
    last_refresh_status: 'SUCCESS',
    monthly_active_views: 1000,
    snowflake_credits_consumed: 100,
    avg_load_time_sec: 5,
    aws_hosting_cost_usd: 100,
    query_count_last_30d: 1000,
    concurrent_user_peak: 10,
    ...overrides,
  };
}

describe('DQ01 isOrphanedOwner', () => {
  it.each(['nan', 'NaN', ' NaN ', 'ORPHANED_REPORT', ' Orphaned_Report ', '', '  '])(
    'flags %j (case-insensitive, trimmed)',
    (raw) => {
      expect(isOrphanedOwner(raw)).toBe(true);
    },
  );
  it.each(['None', 'null', 'N/A'])('does not treat %j as an orphan marker', (raw) => {
    expect(isOrphanedOwner(raw)).toBe(false);
  });
  it('keeps a real email', () => {
    expect(isOrphanedOwner('user_3@company.com')).toBe(false);
  });
});

describe('DQ02 hasNegativeCredits', () => {
  it('flags negative credits only', () => {
    expect(hasNegativeCredits(row({ snowflake_credits_consumed: -0.8 }))).toBe(true);
    expect(hasNegativeCredits(row({ snowflake_credits_consumed: 0 }))).toBe(false);
    expect(hasNegativeCredits(row({ snowflake_credits_consumed: 12.5 }))).toBe(false);
  });
});

describe('DQ03 isSlowLoad / latencySeverity', () => {
  it('uses a strict > threshold', () => {
    expect(isSlowLoad(row({ avg_load_time_sec: config.LATENCY_WARNING_SEC }))).toBe(false);
    expect(isSlowLoad(row({ avg_load_time_sec: config.LATENCY_WARNING_SEC + 0.1 }))).toBe(true);
  });
  it('maps load time to alert severity', () => {
    expect(latencySeverity(config.LATENCY_WARNING_SEC)).toBeNull();
    expect(latencySeverity(config.LATENCY_WARNING_SEC + 0.1)).toBe('WARNING');
    expect(latencySeverity(config.LATENCY_CRITICAL_SEC)).toBe('WARNING');
    expect(latencySeverity(config.LATENCY_CRITICAL_SEC + 0.1)).toBe('CRITICAL');
  });
});

describe('DQ04 isCostMismatch', () => {
  // x = ln(aws/views); median 0 (aws = views), MAD 1.
  const stats: CostStats = { median: 0, mad: 1 };
  const zCutoffX = config.COST_ROBUST_Z / 0.6745;

  it('computes pooled median and MAD of ln(aws/views), skipping non-positive rows', () => {
    const s = computeCostStats([
      { monthly_active_views: 100, aws_hosting_cost_usd: 100 }, // x = 0
      { monthly_active_views: 100, aws_hosting_cost_usd: 100 * Math.E }, // x = 1
      { monthly_active_views: 100, aws_hosting_cost_usd: 100 / Math.E }, // x = -1
      { monthly_active_views: 0, aws_hosting_cost_usd: 500 }, // skipped (log undefined)
    ]);
    expect(s.median).toBeCloseTo(0);
    expect(s.mad).toBeCloseTo(1);
  });

  it('returns null log for non-positive views or cost', () => {
    expect(logCostPerView({ monthly_active_views: 0, aws_hosting_cost_usd: 10 })).toBeNull();
    expect(logCostPerView({ monthly_active_views: 10, aws_hosting_cost_usd: 0 })).toBeNull();
  });

  it('flags robust z beyond the cutoff in either direction', () => {
    const views = 1000;
    const high = {
      monthly_active_views: views,
      aws_hosting_cost_usd: views * Math.exp(zCutoffX + 0.01),
    };
    const low = {
      monthly_active_views: views,
      aws_hosting_cost_usd: views * Math.exp(-zCutoffX - 0.01),
    };
    const inside = {
      monthly_active_views: views,
      aws_hosting_cost_usd: views * Math.exp(zCutoffX - 0.01),
    };
    expect(robustZ(Math.log(high.aws_hosting_cost_usd / views), stats)).toBeGreaterThan(
      config.COST_ROBUST_Z,
    );
    expect(isCostMismatch(high, stats)).toBe(true);
    expect(isCostMismatch(low, stats)).toBe(true);
    expect(isCostMismatch(inside, stats)).toBe(false);
  });

  it('flags the hard rule (views < 50 and AWS > $300) regardless of z', () => {
    const wide: CostStats = { median: 0, mad: 1000 };
    expect(isCostMismatch({ monthly_active_views: 49, aws_hosting_cost_usd: 300.01 }, wide)).toBe(
      true,
    );
    expect(isCostMismatch({ monthly_active_views: 50, aws_hosting_cost_usd: 301 }, wide)).toBe(
      false,
    );
    expect(isCostMismatch({ monthly_active_views: 49, aws_hosting_cost_usd: 300 }, wide)).toBe(
      false,
    );
  });

  it('handles zero views (hard rule only) and MAD = 0 without dividing by zero', () => {
    expect(isCostMismatch({ monthly_active_views: 0, aws_hosting_cost_usd: 100 }, stats)).toBe(
      false,
    );
    expect(isCostMismatch({ monthly_active_views: 0, aws_hosting_cost_usd: 400 }, stats)).toBe(
      true,
    );
    expect(
      isCostMismatch(
        { monthly_active_views: 1000, aws_hosting_cost_usd: 1 },
        { median: 0, mad: 0 },
      ),
    ).toBe(false);
  });
});

describe('DQ05 hasZeroViews', () => {
  it('flags exactly zero views', () => {
    expect(hasZeroViews(row({ monthly_active_views: 0 }))).toBe(true);
    expect(hasZeroViews(row({ monthly_active_views: 1 }))).toBe(false);
  });
});

describe('DQ06 hasImpossibleConcurrency', () => {
  it('flags peak concurrency above monthly views', () => {
    expect(
      hasImpossibleConcurrency(row({ concurrent_user_peak: 11, monthly_active_views: 10 })),
    ).toBe(true);
    expect(
      hasImpossibleConcurrency(row({ concurrent_user_peak: 10, monthly_active_views: 10 })),
    ).toBe(false);
  });
});

describe('DQ07 isUnknownRefresh', () => {
  it('flags UNKNOWN only', () => {
    expect(isUnknownRefresh(row({ last_refresh_status: 'UNKNOWN' }))).toBe(true);
    for (const s of ['SUCCESS', 'FAILED', 'TIMED_OUT'] as const) {
      expect(isUnknownRefresh(row({ last_refresh_status: s }))).toBe(false);
    }
  });
});

describe('DQ08 isSlowButHealthy', () => {
  it('requires SUCCESS and slow load', () => {
    const slow = config.LATENCY_WARNING_SEC + 1;
    expect(isSlowButHealthy(row({ last_refresh_status: 'SUCCESS', avg_load_time_sec: slow }))).toBe(
      true,
    );
    expect(isSlowButHealthy(row({ last_refresh_status: 'FAILED', avg_load_time_sec: slow }))).toBe(
      false,
    );
    expect(isSlowButHealthy(row({ last_refresh_status: 'SUCCESS', avg_load_time_sec: 1 }))).toBe(
      false,
    );
  });
});

describe('DQ09 ownerChanged / resolveCurrentOwner', () => {
  it('never flags a report’s first snapshot', () => {
    expect(ownerChanged(undefined, 'a@x.com')).toBe(false);
    expect(ownerChanged(undefined, null)).toBe(false);
  });
  it('flags transitions, including to and from NULL', () => {
    expect(ownerChanged('a@x.com', 'b@x.com')).toBe(true);
    expect(ownerChanged(null, 'a@x.com')).toBe(true);
    expect(ownerChanged('a@x.com', null)).toBe(true);
  });
  it('does not flag an unchanged owner (NULL → NULL included)', () => {
    expect(ownerChanged('a@x.com', 'a@x.com')).toBe(false);
    expect(ownerChanged(null, null)).toBe(false);
  });
  it('resolves current owner from the latest snapshot unless overridden', () => {
    expect(resolveCurrentOwner(['a@x.com', 'b@x.com'])).toBe('b@x.com');
    expect(resolveCurrentOwner(['a@x.com', null])).toBeNull();
    expect(resolveCurrentOwner(['a@x.com', null], 'c@x.com')).toBe('c@x.com');
    expect(resolveCurrentOwner(['a@x.com'], null)).toBeNull();
    expect(resolveCurrentOwner([])).toBeNull();
  });
});

describe('DQ_RULES registry', () => {
  it('has the nine rules DQ01–DQ09 in order with unique flags', () => {
    expect(DQ_RULES.map((r) => r.id)).toEqual([
      'DQ01',
      'DQ02',
      'DQ03',
      'DQ04',
      'DQ05',
      'DQ06',
      'DQ07',
      'DQ08',
      'DQ09',
    ]);
    expect(new Set(DQ_RULES.map((r) => r.flag)).size).toBe(DQ_RULES.length);
    expect(DQ_RULES.find((r) => r.id === 'DQ09')).toMatchObject({
      name: 'Ownership change (event)',
      severity: 'info',
    });
  });
  it('flagRow returns every applicable flag', () => {
    const r = row({
      owner_raw: 'nan',
      owner_email: null,
      snowflake_credits_consumed: -1,
      avg_load_time_sec: 40,
      monthly_active_views: 0,
      concurrent_user_peak: 3,
    });
    expect(flagRow(r, { costStats: { median: 0, mad: 1 }, prevOwner: 'a@x.com' })).toEqual([
      'ORPHANED',
      'NEGATIVE_CREDITS',
      'SLOW_LOAD',
      'ZERO_VIEWS',
      'IMPOSSIBLE_CONCURRENCY',
      'SLOW_BUT_HEALTHY',
      'OWNER_CHANGED',
    ]);
  });
});
