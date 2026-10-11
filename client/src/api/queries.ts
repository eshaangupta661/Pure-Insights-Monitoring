import { useQuery } from '@tanstack/react-query';
import type { OverviewKpis, OverviewScope, OverviewTrend, PeriodOverview } from '@pic/shared';
import { api } from './http';

/** Today's KPIs; the socket's kpi:update writes this exact key. */
export const OVERVIEW_KEY = ['overview'] as const;
/** Period-to-date KPIs: they change with the replay's snapshot, so they refetch on every tick. */
export const PERIOD_KEY = ['overview', 'period'] as const;
export const ALERTS_KEY = ['alerts'] as const;
export const REPORTS_KEY = ['reports'] as const;
export const REPLAY_KEY = ['replay'] as const;
export const TREND_KEY = ['overview', 'trend'] as const;
/** Orphaned and zombie lists describe the replay's snapshot, so they refetch on every tick. */
export const ANOMALIES_KEY = ['costs', 'anomalies'] as const;
/** Forecast and worked example are for the replay's snapshot, so they refetch on every tick. */
export const PROJECTION_KEY = ['costs', 'projection'] as const;
export const ASSUMPTIONS_KEY = ['costs', 'assumptions'] as const;

export function useOverview() {
  return useQuery({ queryKey: OVERVIEW_KEY, queryFn: () => api<OverviewKpis>('/overview') });
}

export function usePeriodOverview(enabled: boolean) {
  return useQuery({
    queryKey: PERIOD_KEY,
    queryFn: () => api<PeriodOverview>('/overview?scope=period'),
    enabled,
  });
}

export function useTrend(scope: OverviewScope = 'today') {
  return useQuery({
    queryKey: [...TREND_KEY, scope],
    queryFn: () => api<OverviewTrend>(`/overview/trend?scope=${scope}`),
  });
}
