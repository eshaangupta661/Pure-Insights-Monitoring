import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { OverviewScope } from '@pic/shared';

export const SCOPE_PARAM = 'scope';

export const parseScope = (v: string | null): OverviewScope | null =>
  v === 'today' || v === 'period' ? v : null;

/**
 * The header's Today / Period-to-date switch, stored in the URL as `?scope=today|period`.
 * AppShell keeps the parameter on every navigation, so it survives links that drop it.
 */
export function useOverviewScope(): {
  scope: OverviewScope;
  setScope: (scope: OverviewScope) => void;
} {
  const [params, setParams] = useSearchParams();
  const scope = parseScope(params.get(SCOPE_PARAM)) ?? 'today';
  const setScope = useCallback(
    (next: OverviewScope) =>
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          p.set(SCOPE_PARAM, next);
          return p;
        },
        { replace: true },
      ),
    [setParams],
  );
  return { scope, setScope };
}
