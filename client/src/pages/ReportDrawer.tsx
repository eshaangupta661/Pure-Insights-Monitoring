import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, YAxis } from 'recharts';
import type { DqFlag, OwnerOverrideRequest, ReportDetail, ViewerReportDetail } from '@pic/shared';
import { api } from '../api/http';
import { ANOMALIES_KEY, OVERVIEW_KEY, REPORTS_KEY, useTrend } from '../api/queries';
import { useAuth } from '../auth/AuthProvider';
import {
  ErrorState,
  InfoTip,
  RefreshBadge,
  Skeleton,
  controlClass,
  primaryButtonClass,
  refreshLabel,
  secondaryButtonClass,
  OwnerCell,
} from '../components/ui';
import { formatInt, formatSeconds, formatUsd } from '../lib/format';
import { STATUS_ORDER, STATUS_STYLE } from '../lib/status';

type Detail = ReportDetail | ViewerReportDetail;
const hasCost = (d: Detail): d is ReportDetail => 'cost' in d;

const FLAG_LABEL: Record<DqFlag, string> = {
  ORPHANED: 'No owner',
  NEGATIVE_CREDITS: 'Negative credits',
  SLOW_LOAD: 'Slow load',
  COST_MISMATCH: 'Cost vs views mismatch',
  ZERO_VIEWS: 'Zero views',
  IMPOSSIBLE_CONCURRENCY: 'Peak users above views',
  UNKNOWN_REFRESH: 'Unknown refresh',
  SLOW_BUT_HEALTHY: 'Slow but healthy',
  OWNER_CHANGED: 'Owner changed',
};

/**
 * Consecutive snapshots with the same owner collapse into one run, newest first. A run never
 * spans the replay's snapshot, so runs the replay hasn't reached can be shown apart.
 */
function ownerRuns(history: (string | null)[], currentIdx: number) {
  const runs: { owner: string | null; from: number; to: number; replayed: boolean }[] = [];
  history.forEach((owner, i) => {
    const replayed = i <= currentIdx;
    const last = runs[runs.length - 1];
    if (last && last.owner === owner && last.replayed === replayed) last.to = i;
    else runs.push({ owner, from: i, to: i, replayed });
  });
  return runs.reverse();
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-gray-100 py-4">
      <h3 className="mb-2 text-xs font-medium tracking-wide text-gray-500 uppercase">{title}</h3>
      {children}
    </section>
  );
}

function AssignOwner({ report }: { report: Detail }) {
  const queryClient = useQueryClient();
  const known = [...new Set(report.ownerHistory.filter((o): o is string => o !== null))];
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const assign = useMutation({
    mutationFn: (body: OwnerOverrideRequest) =>
      api<ReportDetail>(`/reports/${report.reportId}/owner`, { method: 'PATCH', body }),
    onSuccess: (updated) => {
      queryClient.setQueryData([...REPORTS_KEY, 'detail', report.reportId], updated);
      void queryClient.invalidateQueries({ queryKey: REPORTS_KEY });
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
      void queryClient.invalidateQueries({ queryKey: ANOMALIES_KEY });
      setEmail('');
      setReason('');
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    assign.mutate({ ownerEmail: email.trim() || null, reason: reason.trim() || undefined });
  };

  return (
    <form onSubmit={submit} className="grid gap-2">
      <label className="grid gap-1 text-sm text-gray-700">
        New owner email
        <input
          type="email"
          list="known-owners"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Leave empty to mark as having no owner"
          className={controlClass}
        />
        <datalist id="known-owners">
          {known.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      </label>
      <label className="grid gap-1 text-sm text-gray-700">
        Reason (optional)
        <input
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          className={controlClass}
        />
      </label>
      {assign.isError && (
        <p role="alert" className="text-sm text-critical">
          {assign.error.message}
        </p>
      )}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={assign.isPending}>
          {assign.isPending ? 'Saving…' : email.trim() ? 'Assign owner' : 'Mark as having no owner'}
        </button>
      </div>
    </form>
  );
}

function DrawerBody({ report }: { report: Detail }) {
  const { user } = useAuth();
  const thresholds = useTrend().data?.thresholds;
  const current = report.history[report.snapshotIdx];
  const loadData = report.history.map((h) => ({
    snapshot: h.snapshotIdx + 1,
    loadTimeSec: h.loadTimeSec,
  }));
  const flagCounts = new Map<DqFlag, number>();
  for (const h of report.history)
    for (const f of h.dqFlags) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);

  return (
    <div className="px-5 pb-6">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 pb-4 text-sm">
        <div>
          <dt className="text-xs text-gray-500">Owner</dt>
          <dd className="text-gray-900">
            <OwnerCell report={report} showData={false} />
          </dd>
        </div>
        {report.isOverridden && (
          <div>
            <dt className="text-xs text-gray-500">In data at snapshot {report.snapshotIdx + 1}</dt>
            <dd className="text-gray-700">
              {report.snapshotOwner ?? <span className="italic">No owner</span>}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-xs text-gray-500">Refresh</dt>
          <dd>
            <RefreshBadge status={report.refreshStatus} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Load time</dt>
          <dd className="tabular-nums">{formatSeconds(report.loadTimeSec)}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Monthly views</dt>
          <dd className="tabular-nums">{formatInt(report.monthlyActiveViews)}</dd>
        </div>
        {hasCost(report) && (
          <>
            <div>
              <dt className="text-xs text-gray-500">Snowflake cost (this snapshot)</dt>
              <dd className="tabular-nums">
                {report.snowflakeCostUsd === null
                  ? 'n/a – credits quarantined'
                  : formatUsd(report.snowflakeCostUsd)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">
                Cost per view (30-day basis){' '}
                <InfoTip text="This snapshot’s Snowflake cost covers one day, so it is scaled to 30 days and added to the monthly AWS bill (assumed monthly) before dividing by monthly active views. Cost and views then cover the same 30 days." />
              </dt>
              <dd className="tabular-nums">
                {report.fullyLoadedCostPerView === null
                  ? report.monthlyActiveViews === 0
                    ? 'n/a – 0 views'
                    : 'n/a'
                  : formatUsd(report.fullyLoadedCostPerView)}
              </dd>
            </div>
          </>
        )}
      </dl>

      <Section title="Load time, all snapshots">
        <div className="h-24" role="img" aria-label="Load time per snapshot">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={loadData} margin={{ top: 4, right: 6, bottom: 0, left: 6 }}>
              <YAxis hide domain={[0, 'dataMax']} />
              {thresholds && (
                <ReferenceLine y={thresholds.warningSec} stroke="#d9922b" strokeDasharray="3 3" />
              )}
              <Tooltip
                formatter={(v: number) => [`${v.toFixed(1)} s`, 'Load time']}
                labelFormatter={(l) => `Snapshot ${String(l)}`}
              />
              <Line
                type="monotone"
                dataKey="loadTimeSec"
                stroke="#2a78d6"
                strokeWidth={2}
                dot={(p: { cx?: number; cy?: number; index?: number }) =>
                  p.index === report.snapshotIdx && p.cx !== undefined && p.cy !== undefined ? (
                    <circle
                      key="now"
                      cx={p.cx}
                      cy={p.cy}
                      r={4}
                      fill="#2a78d6"
                      stroke="#fff"
                      strokeWidth={2}
                    />
                  ) : (
                    <g key={p.index} />
                  )
                }
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-2 flex gap-0.5" aria-label="Refresh status per snapshot">
          {report.history.map((h) => (
            <span
              key={h.snapshotIdx}
              title={`Snapshot ${h.snapshotIdx + 1}: ${refreshLabel(h.refreshStatus)}`}
              style={{ background: STATUS_STYLE[h.refreshStatus].fill }}
              className={`h-2 flex-1 rounded-sm ${
                h.snapshotIdx > report.snapshotIdx ? 'opacity-30' : ''
              }`}
            />
          ))}
        </div>
        <p className="mt-1 text-xs text-gray-500">
          Dashed line: warning threshold{thresholds ? ` (${thresholds.warningSec} s)` : ''}. Strip:
          refresh status per snapshot; faded snapshots have not been replayed yet.
        </p>
        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-600">
          {STATUS_ORDER.map((s) => (
            <li key={s} className="flex items-center gap-1">
              <span
                className="size-2 rounded-sm"
                style={{ background: STATUS_STYLE[s].fill }}
                aria-hidden
              />
              {STATUS_STYLE[s].label}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Owner history">
        <ol className="space-y-1 text-sm">
          {report.override && (
            <li className="flex justify-between gap-3">
              <span
                className={report.override.ownerEmail ? 'text-gray-900' : 'text-gray-500 italic'}
              >
                {report.override.ownerEmail ?? 'No owner'}
                <span className="ml-1 text-xs text-gray-500 not-italic">(now)</span>
              </span>
              <span className="shrink-0 text-xs font-medium text-accent-strong">
                Assigned by {report.override.setBy}
              </span>
            </li>
          )}
          {ownerRuns(report.ownerHistory, report.snapshotIdx).map((run) => (
            <li
              key={run.from}
              className={`flex justify-between gap-3 ${run.replayed ? '' : 'opacity-40'}`}
            >
              <span className={run.owner ? 'text-gray-800' : 'text-gray-500 italic'}>
                {run.owner ?? 'No owner'}
                {!report.isOverridden &&
                  run.from <= report.snapshotIdx &&
                  report.snapshotIdx <= run.to && (
                    <span className="ml-1 text-xs text-gray-500 not-italic">(now)</span>
                  )}
              </span>
              <span className="shrink-0 text-xs text-gray-500 tabular-nums">
                {run.from === run.to
                  ? `Snapshot ${run.from + 1}`
                  : `Snapshots ${run.from + 1}–${run.to + 1}`}
                {!run.replayed && ' · not yet replayed'}
              </span>
            </li>
          ))}
        </ol>
        {report.override && (
          <p className="mt-2 text-xs text-gray-500">
            {report.override.reason ? `Reason: ${report.override.reason}. ` : ''}The assigned owner
            now owns the report: access, alerts and current chargeback follow it. The data's history
            below the assignment is kept unchanged.
          </p>
        )}
      </Section>

      <Section title="Data quality flags">
        {flagCounts.size === 0 ? (
          <p className="text-sm text-gray-500">No flags on any snapshot.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {[...flagCounts].map(([flag, n]) => (
              <li
                key={flag}
                className={`rounded border px-2 py-0.5 text-xs ${
                  current?.dqFlags.includes(flag)
                    ? 'border-gray-400 bg-gray-100 text-gray-900'
                    : 'border-gray-200 text-gray-600'
                }`}
              >
                {FLAG_LABEL[flag]} <span className="tabular-nums text-gray-500">×{n}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-xs text-gray-500">
          Snapshots with each flag; highlighted flags apply now.
        </p>
      </Section>

      {user?.role === 'admin' && (
        <Section title="Assign owner">
          <AssignOwner report={report} />
        </Section>
      )}
    </div>
  );
}

export default function ReportDrawer({
  reportId,
  onClose,
}: {
  reportId: string;
  onClose: () => void;
}) {
  const report = useQuery({
    queryKey: [...REPORTS_KEY, 'detail', reportId],
    queryFn: () => api<Detail>(`/reports/${reportId}`),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label={`Report ${reportId}`}
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col overflow-y-auto border-l border-gray-200 bg-white shadow-xl"
      >
        <header className="flex items-start justify-between gap-3 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              {report.data?.reportName ?? reportId}
            </h2>
            <p className="text-xs text-gray-500">{reportId}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-gray-500 hover:bg-gray-100"
          >
            <X className="size-4" />
          </button>
        </header>
        {report.isPending && (
          <div className="space-y-3 px-5">
            <Skeleton className="h-16" />
            <Skeleton className="h-32" />
          </div>
        )}
        {report.isError && (
          <ErrorState message={report.error.message} onRetry={() => void report.refetch()} />
        )}
        {report.data && <DrawerBody report={report.data} />}
        <div className="mt-auto border-t border-gray-100 px-5 py-3">
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            Close
          </button>
        </div>
      </aside>
    </>
  );
}
