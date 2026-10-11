import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Page, RefreshStatus, ViewerReportSummary } from '@pic/shared';
import { api } from '../api/http';
import { REPORTS_KEY } from '../api/queries';
import {
  Card,
  EmptyState,
  ErrorState,
  Pagination,
  RefreshBadge,
  Skeleton,
  controlClass,
  refreshLabel,
} from '../components/ui';
import { formatInt, formatSeconds } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { useTrend } from '../api/queries';
import ReportDrawer from './ReportDrawer';

const PAGE_SIZE = 25;
const STATUSES: RefreshStatus[] = ['SUCCESS', 'FAILED', 'TIMED_OUT', 'UNKNOWN'];
type SortKey = 'reportId' | 'loadTime' | 'views' | 'status';

const isStatus = (v: string | null): v is RefreshStatus =>
  v !== null && (STATUSES as string[]).includes(v);
const isSort = (v: string | null): v is SortKey =>
  v === 'reportId' || v === 'loadTime' || v === 'views' || v === 'status';

function SortHeader({
  label,
  k,
  sort,
  order,
  onSort,
  align = 'left',
}: {
  label: string;
  k: SortKey;
  sort: SortKey;
  order: 'asc' | 'desc';
  onSort: (k: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = sort === k;
  return (
    <th
      scope="col"
      aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`py-2 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className="inline-flex items-center gap-1 hover:text-gray-900"
      >
        {label}
        {active &&
          (order === 'asc' ? (
            <ArrowUp className="size-3" aria-hidden />
          ) : (
            <ArrowDown className="size-3" aria-hidden />
          ))}
      </button>
    </th>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-sm text-gray-700">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export default function ReportsPage() {
  const { id: selectedId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const warningSec = useTrend().data?.thresholds.warningSec;

  const q = params.get('q') ?? '';
  const [search, setSearch] = useState(q);
  const debouncedSearch = useDebounced(search, 300);
  const statusParam = params.get('status');
  const status = isStatus(statusParam) ? statusParam : undefined;
  const orphaned = params.get('orphaned') === 'true';
  const slow = params.get('slow') === 'true';
  const sortParam = params.get('sort');
  const sort: SortKey = isSort(sortParam) ? sortParam : 'reportId';
  const order = params.get('order') === 'desc' ? 'desc' : 'asc';
  const page = Math.max(1, Number(params.get('page')) || 1);

  const update = (changes: Record<string, string | null>, keepPage = false) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(changes)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        if (!keepPage) next.delete('page');
        return next;
      },
      { replace: true },
    );

  // The URL follows the debounced search box.
  useEffect(() => {
    if (debouncedSearch !== q) update({ q: debouncedSearch.trim() || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  const query = new URLSearchParams({
    page: String(page),
    pageSize: String(PAGE_SIZE),
    sort,
    order,
  });
  if (q) query.set('q', q);
  if (status) query.set('status', status);
  if (orphaned) query.set('orphaned', 'true');
  if (slow) query.set('slow', 'true');

  const reports = useQuery({
    queryKey: [...REPORTS_KEY, 'list', query.toString()],
    queryFn: () => api<Page<ViewerReportSummary>>(`/reports?${query.toString()}`),
    placeholderData: keepPreviousData,
  });

  const onSort = (k: SortKey) =>
    update({ sort: k, order: sort === k && order === 'asc' ? 'desc' : 'asc' });
  const filtered = Boolean(q || status || orphaned || slow);
  const listSearch = params.toString();

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">Reports</h1>
        <p className="text-xs text-gray-500">At the replay’s current snapshot.</p>
      </div>

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <label className="relative">
            <span className="sr-only">Search reports</span>
            <Search
              className="pointer-events-none absolute top-2 left-2.5 size-4 text-gray-400"
              aria-hidden
            />
            <input
              type="search"
              placeholder="Search id, name or owner"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={`${controlClass} w-64 pl-8`}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            Refresh
            <select
              className={controlClass}
              value={status ?? ''}
              onChange={(e) => update({ status: e.target.value || null })}
            >
              <option value="">Any</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {refreshLabel(s)}
                </option>
              ))}
            </select>
          </label>
          <Toggle
            label="No owner"
            checked={orphaned}
            onChange={(c) => update({ orphaned: c ? 'true' : null })}
          />
          <Toggle
            label={warningSec ? `Slow (> ${warningSec} s)` : 'Slow'}
            checked={slow}
            onChange={(c) => update({ slow: c ? 'true' : null })}
          />
          {filtered && (
            <button
              type="button"
              className="text-sm text-accent hover:underline"
              onClick={() => {
                setSearch('');
                setParams({}, { replace: true });
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        {reports.isPending && <Skeleton className="h-64" />}
        {reports.isError && (
          <ErrorState message={reports.error.message} onRetry={() => void reports.refetch()} />
        )}
        {reports.data &&
          (reports.data.items.length === 0 ? (
            <EmptyState
              title="No reports match"
              hint={filtered ? 'Try clearing a filter.' : 'There are no reports in your scope.'}
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead className="border-b border-gray-200 text-xs text-gray-500">
                    <tr>
                      <SortHeader
                        label="Report"
                        k="reportId"
                        sort={sort}
                        order={order}
                        onSort={onSort}
                      />
                      <th scope="col" className="py-2 text-left font-medium">
                        Owner
                      </th>
                      <SortHeader
                        label="Refresh"
                        k="status"
                        sort={sort}
                        order={order}
                        onSort={onSort}
                      />
                      <SortHeader
                        label="Load time"
                        k="loadTime"
                        sort={sort}
                        order={order}
                        onSort={onSort}
                        align="right"
                      />
                      <SortHeader
                        label="Views"
                        k="views"
                        sort={sort}
                        order={order}
                        onSort={onSort}
                        align="right"
                      />
                      <th scope="col" className="py-2 text-right font-medium">
                        DQ flags
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {reports.data.items.map((r) => (
                      <tr
                        key={r.reportId}
                        tabIndex={0}
                        aria-selected={r.reportId === selectedId}
                        onClick={() =>
                          navigate({ pathname: `/reports/${r.reportId}`, search: listSearch })
                        }
                        onKeyDown={(e) =>
                          e.key === 'Enter' &&
                          navigate({ pathname: `/reports/${r.reportId}`, search: listSearch })
                        }
                        className={`cursor-pointer hover:bg-gray-50 focus:bg-gray-50 focus:outline-none ${
                          r.reportId === selectedId ? 'bg-accent-soft' : ''
                        }`}
                      >
                        <td className="py-2 pr-3">
                          <span className="font-medium text-gray-900">{r.reportName}</span>{' '}
                          <span className="text-gray-500">{r.reportId}</span>
                        </td>
                        <td className="py-2 pr-3 text-gray-700">
                          {r.currentOwner ?? <span className="text-gray-500 italic">No owner</span>}
                        </td>
                        <td className="py-2 pr-3">
                          <RefreshBadge status={r.refreshStatus} />
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {formatSeconds(r.loadTimeSec)}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {r.monthlyActiveViews === 0 ? (
                            <span className="text-gray-500">0</span>
                          ) : (
                            formatInt(r.monthlyActiveViews)
                          )}
                        </td>
                        <td className="py-2 text-right text-gray-600 tabular-nums">
                          {r.dqFlags.length}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={reports.data.page}
                pageSize={reports.data.pageSize}
                total={reports.data.total}
                onPage={(p) => update({ page: String(p) }, true)}
              />
            </>
          ))}
      </Card>

      {selectedId && (
        <ReportDrawer
          reportId={selectedId}
          onClose={() => navigate({ pathname: '/reports', search: listSearch })}
        />
      )}
    </div>
  );
}
