import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Alert, AlertSort, AlertStatus, BulkAckResult, Page, Severity } from '@pic/shared';
import { api } from '../api/http';
import { ALERTS_KEY, OVERVIEW_KEY } from '../api/queries';
import {
  Card,
  EmptyState,
  ErrorState,
  Pagination,
  SeverityBadge,
  Skeleton,
  controlClass,
  primaryButtonClass,
} from '../components/ui';
import { useAuth } from '../auth/AuthProvider';
import { useDebounced } from '../lib/useDebounced';
import { useAlerts } from '../realtime/AlertsProvider';

const PAGE_SIZE = 25;
/** Grouped by report, a page holds whole reports, so it asks for the most the API allows. */
const GROUPED_PAGE_SIZE = 100;
const STATUSES: AlertStatus[] = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'];
const STATUS_LABEL: Record<AlertStatus, string> = {
  OPEN: 'Open',
  ACKNOWLEDGED: 'Acknowledged',
  RESOLVED: 'Resolved',
};
const SEVERITY_RANK: Record<Severity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

/**
 * The severity filter. No `severity` in the URL means the default, Critical + Warning: Info
 * alerts (an UNKNOWN refresh) are noise on a first look and one click away.
 */
const SEVERITY_OPTIONS = [
  { value: '', label: 'Critical + Warning', api: 'CRITICAL,WARNING' },
  { value: 'all', label: 'All severities', api: undefined },
  { value: 'CRITICAL', label: 'Critical only', api: 'CRITICAL' },
  { value: 'WARNING', label: 'Warning only', api: 'WARNING' },
  { value: 'INFO', label: 'Info only', api: 'INFO' },
] as const;

const RULE_LABEL: Record<Alert['ruleId'], string> = {
  LATENCY: 'Load time',
  REFRESH_FAILED: 'Refresh failed',
  REFRESH_UNKNOWN: 'Refresh unknown',
};

const isOneOf = <T extends string>(list: readonly T[], v: string | null): v is T =>
  v !== null && (list as readonly string[]).includes(v);

const compactButton =
  'inline-flex items-center gap-1 whitespace-nowrap rounded border border-gray-300 bg-white px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50';

/** One row is about 40px on wide screens; narrower ones wrap instead of clipping. */
const ROW =
  'flex min-h-10 flex-wrap items-center gap-x-3 gap-y-0.5 py-1 text-sm md:h-10 md:flex-nowrap';

function snapshots(alert: Alert): string {
  const last =
    alert.status === 'RESOLVED' && alert.resolvedTick !== undefined
      ? alert.resolvedTick
      : alert.lastSeenTick;
  return alert.openedTick === last
    ? `${alert.openedTick + 1}`
    : `${alert.openedTick + 1}–${last + 1}`;
}

function detailTitle(alert: Alert): string {
  return [
    alert.message,
    `Owner: ${alert.ownerEmail ?? 'none'}`,
    `Opened at snapshot ${alert.openedTick + 1}`,
    alert.status === 'RESOLVED' && alert.resolvedTick !== undefined
      ? `Resolved at snapshot ${alert.resolvedTick + 1}`
      : `Last seen at snapshot ${alert.lastSeenTick + 1}`,
    alert.ackedBy ? `Acknowledged by ${alert.ackedBy}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function SyntheticTag() {
  return (
    <span
      className="rounded border border-dashed border-gray-400 px-1 text-xs text-gray-600"
      title="Injected by an admin; not in the data set"
    >
      synthetic
    </span>
  );
}

function Checkbox({
  checked,
  indeterminate = false,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="size-4 shrink-0"
    />
  );
}

interface RowProps {
  alert: Alert;
  /** Grouped rows sit under their report, so they drop the report column. */
  grouped: boolean;
  canAck: boolean;
  selected: boolean;
  onSelect: (id: string, checked: boolean) => void;
  onAck: (id: string) => void;
  acking: boolean;
}

function AlertRow({ alert, grouped, canAck, selected, onSelect, onAck, acking }: RowProps) {
  const open = alert.status === 'OPEN';
  return (
    <li className={`${ROW} ${grouped ? 'pl-9' : ''}`} title={detailTitle(alert)}>
      {canAck && (
        <Checkbox
          label={`Select alert on ${alert.reportName}`}
          checked={selected}
          disabled={!open}
          onChange={(c) => onSelect(alert.id, c)}
        />
      )}
      <span className="w-[5.5rem] shrink-0">
        <SeverityBadge severity={alert.severity} />
      </span>
      {grouped ? (
        <span className="w-28 shrink-0 text-gray-700">{RULE_LABEL[alert.ruleId]}</span>
      ) : (
        <span className="min-w-0 basis-48 truncate md:w-56 md:flex-none xl:w-60">
          <Link
            to={`/reports/${alert.reportId}`}
            className="font-medium text-gray-900 hover:text-accent hover:underline"
          >
            {alert.reportName}
          </Link>{' '}
          <span className="text-gray-500">{alert.reportId}</span>
        </span>
      )}
      <span className="min-w-0 flex-1 basis-48 truncate text-gray-700">
        {alert.message}
        {alert.synthetic && (
          <>
            {' '}
            <SyntheticTag />
          </>
        )}
      </span>
      {!grouped && (
        <span className="hidden w-40 shrink-0 truncate text-xs text-gray-500 xl:block">
          {alert.ownerEmail ?? <span className="italic">No owner</span>}
        </span>
      )}
      <span className="hidden w-12 shrink-0 text-xs text-gray-500 tabular-nums lg:block">
        {snapshots(alert)}
      </span>
      <span className="w-[5.5rem] shrink-0 text-xs text-gray-600">
        {STATUS_LABEL[alert.status]}
      </span>
      <span className="w-10 shrink-0 text-right lg:w-28">
        {canAck && open && (
          <button
            type="button"
            className={compactButton}
            disabled={acking}
            aria-label={`Acknowledge alert on ${alert.reportName}`}
            title="Acknowledge"
            onClick={() => onAck(alert.id)}
          >
            <Check className="size-3" aria-hidden />
            <span className="hidden lg:inline">{acking ? 'Acking…' : 'Acknowledge'}</span>
          </button>
        )}
      </span>
    </li>
  );
}

interface Group {
  reportId: string;
  reportName: string;
  ownerEmail: string | null;
  alerts: Alert[];
  top: Severity;
}

/** Alerts per report, most severe report first, then the one with the most active alerts. */
function groupByReport(alerts: Alert[]): Group[] {
  const byReport = new Map<string, Group>();
  for (const a of alerts) {
    const g = byReport.get(a.reportId);
    if (g) {
      g.alerts.push(a);
      if (SEVERITY_RANK[a.severity] > SEVERITY_RANK[g.top]) g.top = a.severity;
    } else {
      byReport.set(a.reportId, {
        reportId: a.reportId,
        reportName: a.reportName,
        ownerEmail: a.ownerEmail,
        alerts: [a],
        top: a.severity,
      });
    }
  }
  const active = (g: Group) => g.alerts.filter((a) => a.status !== 'RESOLVED').length;
  return [...byReport.values()].sort(
    (a, b) =>
      SEVERITY_RANK[b.top] - SEVERITY_RANK[a.top] ||
      active(b) - active(a) ||
      a.reportId.localeCompare(b.reportId),
  );
}

export default function AlertsPage() {
  const { user } = useAuth();
  const { ack, status: connection } = useAlerts();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [acking, setAcking] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const statusParam = params.get('status');
  const severityParam = params.get('severity') ?? '';
  const showResolved = params.get('resolved') === 'true';
  const grouped = params.get('group') === 'report';
  const sort: AlertSort = params.get('sort') === 'snapshot' ? 'snapshot' : 'severity';
  const parsedStatus = isOneOf(STATUSES, statusParam) ? statusParam : undefined;
  // RESOLVED is only selectable while resolved alerts are shown.
  const status = parsedStatus === 'RESOLVED' && !showResolved ? undefined : parsedStatus;
  const q = params.get('q') ?? '';
  const [search, setSearch] = useState(q);
  const debouncedSearch = useDebounced(search, 300);
  const severityOption =
    SEVERITY_OPTIONS.find((o) => o.value === severityParam) ?? SEVERITY_OPTIONS[0];
  const page = Math.max(1, Number(params.get('page')) || 1);
  const pageSize = grouped ? GROUPED_PAGE_SIZE : PAGE_SIZE;

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

  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (status) query.set('status', status);
  if (severityOption.api) query.set('severity', severityOption.api);
  if (!showResolved) query.set('resolved', 'false');
  if (q) query.set('q', q);
  if (sort !== 'severity') query.set('sort', sort);
  const alerts = useQuery({
    queryKey: [...ALERTS_KEY, query.toString()],
    queryFn: () => api<Page<Alert>>(`/alerts?${query.toString()}`),
    placeholderData: keepPreviousData,
  });

  const items = useMemo(() => alerts.data?.items ?? [], [alerts.data]);
  const groups = useMemo(() => (grouped ? groupByReport(items) : []), [grouped, items]);

  // A selection belongs to the list it was made on: drop ids that left it (filter, page, ack).
  const visibleOpen = useMemo(
    () => new Set(items.filter((a) => a.status === 'OPEN').map((a) => a.id)),
    [items],
  );
  useEffect(() => {
    setSelected((prev) => {
      const kept = [...prev].filter((id) => visibleOpen.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [visibleOpen]);

  const canAck = user?.role === 'admin' || user?.role === 'owner';
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ALERTS_KEY });
    void queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
  };

  const onAck = async (id: string) => {
    setAcking(id);
    setMessage(null);
    try {
      await ack(id);
      refresh();
    } catch (err) {
      setMessage({
        text: err instanceof Error ? err.message : 'Could not acknowledge',
        error: true,
      });
    } finally {
      setAcking(null);
    }
  };

  const bulkAck = useMutation({
    mutationFn: (alertIds: string[]) =>
      api<BulkAckResult>('/alerts/ack', { method: 'POST', body: { alertIds } }),
    onMutate: () => setMessage(null),
    onSuccess: (res) => {
      const skipped = res.skipped.length;
      setMessage({
        text:
          `Acknowledged ${res.newlyAcknowledged} alert${res.newlyAcknowledged === 1 ? '' : 's'}` +
          (skipped ? `; ${skipped} skipped (already resolved or gone)` : ''),
        error: false,
      });
      setSelected(new Set());
      refresh();
    },
    onError: (err) => setMessage({ text: err.message, error: true }),
  });

  const select = (id: string, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  const selectMany = (ids: string[], checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const allSelected = visibleOpen.size > 0 && selected.size === visibleOpen.size;

  const rowProps = (a: Alert): RowProps => ({
    alert: a,
    grouped,
    canAck,
    selected: selected.has(a.id),
    onSelect: select,
    onAck: (id) => void onAck(id),
    acking: acking === a.id,
  });

  const filtered = Boolean(status || severityParam || q);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight text-gray-900">Alerts</h1>
        <p className="text-xs text-gray-500">
          {connection === 'connected'
            ? 'Live: new alerts appear as the replay advances.'
            : 'Not connected: the list may be out of date until the connection returns.'}
        </p>
      </div>

      <Card>
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
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
              value={severityOption.value}
              onChange={(e) => setFilter('severity', e.target.value)}
            >
              {SEVERITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            Sort by
            <select
              className={controlClass}
              value={sort}
              onChange={(e) => setFilter('sort', e.target.value === 'snapshot' ? 'snapshot' : '')}
            >
              <option value="severity">Severity</option>
              <option value="snapshot">Snapshot (newest first)</option>
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
              className={`${controlClass} w-48 pl-8`}
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
          <label className="flex items-center gap-1.5 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={grouped}
              onChange={(e) => setFilter('group', e.target.checked ? 'report' : '')}
            />
            Group by report
          </label>
        </div>

        {canAck && items.length > 0 && (
          <div className="mb-1 flex min-h-8 flex-wrap items-center gap-3 border-y border-gray-100 py-1 text-sm text-gray-700">
            <label className="flex items-center gap-2">
              <Checkbox
                label="Select all open alerts in this list"
                checked={allSelected}
                indeterminate={selected.size > 0 && !allSelected}
                disabled={visibleOpen.size === 0}
                onChange={(c) => selectMany([...visibleOpen], c)}
              />
              {selected.size > 0
                ? `${selected.size} selected`
                : `Select all open (${visibleOpen.size})`}
            </label>
            <button
              type="button"
              className={`${primaryButtonClass} py-1 text-xs`}
              disabled={selected.size === 0 || bulkAck.isPending}
              onClick={() => bulkAck.mutate([...selected])}
            >
              {bulkAck.isPending ? 'Acknowledging…' : `Acknowledge selected (${selected.size})`}
            </button>
          </div>
        )}

        {message && (
          <p
            role={message.error ? 'alert' : 'status'}
            className={`mb-1 text-sm ${message.error ? 'text-critical' : 'text-gray-700'}`}
          >
            {message.text}
          </p>
        )}

        {alerts.isPending && <Skeleton className="h-48" />}
        {alerts.isError && (
          <ErrorState message={alerts.error.message} onRetry={() => void alerts.refetch()} />
        )}
        {alerts.data &&
          (items.length === 0 ? (
            <EmptyState
              title="No alerts match"
              hint={
                filtered
                  ? 'Try clearing a filter.'
                  : showResolved
                    ? 'No alerts yet.'
                    : 'No active critical or warning alerts. Everything in view is healthy.'
              }
            />
          ) : (
            <>
              {!grouped && (
                <div
                  className="hidden gap-x-3 border-b border-gray-200 pb-1 text-xs text-gray-500 md:flex"
                  aria-hidden
                >
                  {canAck && <span className="w-4 shrink-0" />}
                  <span className="w-[5.5rem] shrink-0">Severity</span>
                  <span className="w-56 shrink-0 xl:w-60">Report</span>
                  <span className="flex-1">Detail</span>
                  <span className="hidden w-40 shrink-0 xl:block">Owner</span>
                  <span className="hidden w-12 shrink-0 lg:block">Snapshots</span>
                  <span className="w-[5.5rem] shrink-0">Status</span>
                  <span className="w-10 shrink-0 lg:w-28" />
                </div>
              )}
              {grouped ? (
                <ul className="divide-y divide-gray-200">
                  {groups.map((g) => {
                    const openIds = g.alerts.filter((a) => a.status === 'OPEN').map((a) => a.id);
                    const picked = openIds.filter((id) => selected.has(id)).length;
                    const isCollapsed = collapsed.has(g.reportId);
                    return (
                      <li key={g.reportId}>
                        <div className={`${ROW} bg-gray-50 px-1`}>
                          {canAck && (
                            <Checkbox
                              label={`Select open alerts on ${g.reportName}`}
                              checked={openIds.length > 0 && picked === openIds.length}
                              indeterminate={picked > 0 && picked < openIds.length}
                              disabled={openIds.length === 0}
                              onChange={(c) => selectMany(openIds, c)}
                            />
                          )}
                          <button
                            type="button"
                            aria-expanded={!isCollapsed}
                            aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${g.reportName}`}
                            className="text-gray-500 hover:text-gray-900"
                            onClick={() =>
                              setCollapsed((prev) => {
                                const next = new Set(prev);
                                if (isCollapsed) next.delete(g.reportId);
                                else next.add(g.reportId);
                                return next;
                              })
                            }
                          >
                            {isCollapsed ? (
                              <ChevronRight className="size-4" aria-hidden />
                            ) : (
                              <ChevronDown className="size-4" aria-hidden />
                            )}
                          </button>
                          <span className="w-[5.5rem] shrink-0">
                            <SeverityBadge severity={g.top} />
                          </span>
                          <span className="min-w-0 flex-1 basis-48 truncate">
                            <Link
                              to={`/reports/${g.reportId}`}
                              className="font-medium text-gray-900 hover:text-accent hover:underline"
                            >
                              {g.reportName}
                            </Link>{' '}
                            <span className="text-gray-500">{g.reportId}</span>
                            <span className="ml-2 text-xs text-gray-500">
                              {g.alerts.length} alert{g.alerts.length === 1 ? '' : 's'}
                            </span>
                          </span>
                          <span className="hidden w-40 shrink-0 truncate text-xs text-gray-500 xl:block">
                            {g.ownerEmail ?? <span className="italic">No owner</span>}
                          </span>
                          <span className="w-44 shrink-0 text-right">
                            {canAck && openIds.length > 0 && (
                              <button
                                type="button"
                                className={compactButton}
                                disabled={bulkAck.isPending}
                                onClick={() => bulkAck.mutate(openIds)}
                              >
                                <Check className="size-3" aria-hidden />
                                Acknowledge {openIds.length} open
                              </button>
                            )}
                          </span>
                        </div>
                        {!isCollapsed && (
                          <ul className="divide-y divide-gray-100">
                            {g.alerts.map((a) => (
                              <AlertRow key={a.id} {...rowProps(a)} />
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {items.map((a) => (
                    <AlertRow key={a.id} {...rowProps(a)} />
                  ))}
                </ul>
              )}
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
