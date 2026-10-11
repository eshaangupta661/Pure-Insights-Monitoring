import { useQuery } from '@tanstack/react-query';
import type { OverviewKpis, OverviewTrend } from '@pic/shared';
import { api } from './http';

export const OVERVIEW_KEY = ['overview'] as const;
export const TREND_KEY = ['overview', 'trend'] as const;

export function useOverview() {
  return useQuery({ queryKey: OVERVIEW_KEY, queryFn: () => api<OverviewKpis>('/overview') });
}

export function useTrend() {
  return useQuery({ queryKey: TREND_KEY, queryFn: () => api<OverviewTrend>('/overview/trend') });
}
