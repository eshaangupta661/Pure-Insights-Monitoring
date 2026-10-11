import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Alert, AlertStatus, Page, Severity } from '@pic/shared';
import { api } from '../api/http';
import { ALERTS_KEY } from '../api/queries';
import AdminControls from '../components/AdminControls';
import {
  Card,
  EmptyState,
  ErrorState,
  Pagination,
  SeverityBadge,
  Skeleton,
  controlClass,
  secondaryButtonClass,
} from '../components/ui';
import { useAuth } from '../auth/AuthProvider';
import { useDebounced } from '../lib/useDebounced';
import { useAlerts } from '../realtime/AlertsProvider';

const PAGE_SIZE = 20;
const STATUSES: AlertStatus[] = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'];
const SEVERITIES: Severity[] = ['CRITICAL', 'WARNING', 'INFO'];
const STATUS_LABEL: Record<AlertStatus, string> = {
  OPEN: 'Open',
  ACKNOWLEDGED: 'Acknowledged',
  RESOLVED: 'Resolved',
};

const isOneOf = <T extends string>(list: readonly T[], v: string | null): v is T =>
  v !== null && (list as readonly string[]).includes(v);

function AlertRow({
  alert,
  canAck,
  onAck,
  acking,
}: {
  alert: Alert;
  canAck: boolean;
  onAck: (id: string) => void;
  acking: boolean;
}) {
  return (
    <li className="flex flex-wrap items-start gap-3 py-3">
      <SeverityBadge severity={alert.severity} />
      <div className="min-w-0 flex-1 basis-60">
        <p className="text-sm font-medium text-gray-900">
          <Link to={`/reports/${alert.reportId}`} className="hover:text-accent hover:underline">
            {alert.reportName}
          </Link>{' '}
          <span className="font-normal text-gray-500">{alert.reportId}</span>
          {alert.synthetic && (
            <span
              className="ml-2 rounded border border-dashed border-gray-400 px-1.5 py-0.5 text-xs font-normal text-gray-600"
              title="Injected by an admin; not in the data set"
            >
              synthetic
            </span>
          )}
        </p>
        <p className="text-sm text-gray-700">{alert.message}</p>
        <p className="mt-0.5 text-xs text-gray-500">
          {alert.ownerEmail ?? 'No owner'} · opened at snapshot {alert.openedTick + 1}
          {alert.status === 'RESOLVED' && alert.resolvedTick !== undefined
            ? `, resolved at ${alert.resolvedTick + 1}`
            : `, last seen ${alert.lastSeenTick + 1}`}
          {alert.ackedBy && ` · acknowledged by ${alert.ackedBy}`}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-600">{STATUS_LABEL[alert.status]}</span>
        {canAck && alert.status === 'OPEN' && (
          <button
            type="button"
            className={`${secondaryButtonClass} flex items-center gap-1`}
            disabled={acking}
            onClick={() => onAck(alert.id)}
          >
            <Check className="size-3.5" aria-hidden />
            {acking ? 'Acknowledging…' : 'Acknowledge'}
          </button>
        )}
      </div>
    </li>
  );
}

export default function AlertsPage() {
  const { user } = useAuth();
  const { ack, status: connection } = useAlerts();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [acking, setAcking] = useState<string | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);

  const statusParam = params.get('status');
  const severityParam = params.get('severity');
  const showResolved = params.get('resolved') === 'true';
  const parsedStatus = isOneOf(STATUSES, statusParam) ? statusParam : undefined;
  // RESOLVED is only selectable while resolved alerts are shown.
  const status = parsedStatus === 'RESOLVED' && !showResolved ? undefined : parsedStatus;
  const q = params.get('q') ?? '';
  const [search, setSearch] = useState(q);
  const debouncedSearch = useDebounced(search, 300);
  const severity = isOneOf(SEVERITIES, severityParam) ? severityParam : undefined;
  const page = Math.max(1, Number(params.get('page')) || 1);

  const setFilter = (key: string, value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        next.delete('page');
        return next;
      },
      { replace: true },
    );

  // The URL follows the debounced search box.
  useEffect(() => {
    if (debouncedSearch.trim() !== q) setFilter('q', debouncedSearch.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  const toggleResolved = (checked: boolean) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (checked) next.set('resolved', 'true');
        else {
          next.delete('resolved');
          if (next.get('status') === 'RESOLVED') next.delete('status');
        }
        next.delete('page');
        return next;
      },
      { replace: true },
    );

  const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (status) query.set('status', status);
  if (severity) query.set('severity', severity);
  if (!showResolved) query.set('resolved', 'false');
  if (q) query.set('q', q);
  const alerts = useQuery({
    queryKey: [...ALERTS_KEY, { status, severity, showResolved, q, page }],
    queryFn: () => api<Page<Alert>>(`/alerts?${query.toString()}`),
    placeholderData: keepPreviousData,
  });

  const canAck = user?.role === 'admin' || user?.role === 'owner';
  const onAck = async (id: string) => {
    setAcking(id);
    setAckError(null);
    try {
      await ack(id);
      await queryClient.invalidateQueries({ queryKey: ALERTS_KEY });
    } catch (err) {
      setAckError(err instanceof Error ? err.message : 'Could not acknowledge');
    } finally {
      setAcking(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">Alerts</h1>
        <p className="text-xs text-gray-500">
          {connection === 'connected'
            ? 'Live: new alerts appear as the replay advances.'
            : 'Not connected: the list may be out of date until the connection returns.'}
        </p>
      </div>

      {user?.role === 'admin' && <AdminControls />}

      <Card>
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            Status
            <select
              className={controlClass}
              value={status ?? ''}
              onChange={(e) => setFilter('status', e.target.value)}
            >
              <option value="">{showResolved ? 'All' : 'Active'}</option>
              {STATUSES.filter((s) => showResolved || s !== 'RESOLVED').map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            Severity
            <select
              className={controlClass}
              value={severity ?? ''}
              onChange={(e) => setFilter('severity', e.target.value)}
            >
              <option value="">All</option>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s.charAt(0) + s.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          <label className="relative">
            <span className="sr-only">Search alerts by report</span>
            <Search
              className="pointer-events-none absolute top-2 left-2.5 size-4 text-gray-400"
              aria-hidden
            />
            <input
              type="search"
              placeholder="Report id or name"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={`${controlClass} w-52 pl-8`}
            />
          </label>
          <label className="flex items-center gap-1.5 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => toggleResolved(e.target.checked)}
            />
            Show resolved
          </label>
        </div>

        {ackError && (
          <p role="alert" className="mb-2 text-sm text-critical">
            {ackError}
          </p>
        )}

        {alerts.isPending && <Skeleton className="h-48" />}
        {alerts.isError && (
          <ErrorState message={alerts.error.message} onRetry={() => void alerts.refetch()} />
        )}
        {alerts.data &&
          (alerts.data.items.length === 0 ? (
            <EmptyState
              title="No alerts match"
              hint={
                status || severity || q
                  ? 'Try clearing a filter.'
                  : showResolved
                    ? 'No alerts yet.'
                    : 'No active alerts. Everything in view is healthy.'
              }
            />
          ) : (
            <>
              <ul className="divide-y divide-gray-100">
                {alerts.data.items.map((a) => (
                  <AlertRow
                    key={a.id}
                    alert={a}
                    canAck={canAck}
                    onAck={(id) => void onAck(id)}
                    acking={acking === a.id}
                  />
                ))}
              </ul>
              <Pagination
                page={alerts.data.page}
                pageSize={alerts.data.pageSize}
                total={alerts.data.total}
                onPage={(p) =>
                  setParams(
                    (prev) => {
                      const next = new URLSearchParams(prev);
                      next.set('page', String(p));
                      return next;
                    },
                    { replace: true },
                  )
                }
              />
            </>
          ))}
      </Card>
    </div>
  );
}
