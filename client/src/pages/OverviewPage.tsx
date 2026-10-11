import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  LatencyBucket,
  OverviewKpis,
  OverviewTrend,
  PeriodOverview,
  RefreshStatus,
} from '@pic/shared';
import { useOverview, usePeriodOverview, useTrend } from '../api/queries';
import { Card, EmptyState, ErrorState, SeverityBadge, Skeleton } from '../components/ui';
import { formatInt, formatPercent, formatSeconds, formatUsd } from '../lib/format';
import { useOverviewScope } from '../lib/overviewScope';
import { STATUS_ORDER, STATUS_STYLE } from '../lib/status';
import { useAlerts } from '../realtime/AlertsProvider';

/** Chart colors by refresh status (categorical order); each also appears in the legend. */
const REFRESH_SERIES: readonly { key: RefreshStatus; label: string; color: string }[] =
  STATUS_ORDER.map((key) => ({
    key,
    label: STATUS_STYLE[key].label,
    color: STATUS_STYLE[key].fill,
  }));
const TOP_PROBLEMS = 5;
const AXIS = { fontSize: 11, fill: '#6b7280' } as const;

function Tile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900 tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-gray-500">{detail}</p>
    </div>
  );
}

function KpiTiles({ kpis, warningSec }: { kpis: OverviewKpis; warningSec: number | undefined }) {
  const refreshed = Object.values(kpis.refresh).reduce((a, b) => a + b, 0);
  const failing = kpis.refresh.FAILED + kpis.refresh.TIMED_OUT;
  const cost = kpis.totals.snapshotSnowflakeCostUsd + kpis.totals.snapshotAwsCostUsd;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <Tile
        label="Reports"
        value={formatInt(kpis.reportCount)}
        detail={`${formatInt(kpis.orphanedCount)} without an owner`}
      />
      <Tile
        label="Refresh success"
        value={refreshed ? formatPercent(kpis.refresh.SUCCESS / refreshed) : '—'}
        detail={`${formatInt(failing)} failed or timed out · ${formatInt(kpis.refresh.UNKNOWN)} unknown`}
      />
      <Tile
        label={warningSec ? `Slow reports (> ${warningSec} s)` : 'Slow reports'}
        value={formatInt(kpis.slowCount)}
        detail={`${formatInt(kpis.criticalSlowCount)} critical · avg ${formatSeconds(kpis.avgLoadTimeSec)}`}
      />
      <Tile
        label="Active alerts"
        value={formatInt(kpis.alerts.total)}
        detail={`${formatInt(kpis.alerts.CRITICAL)} critical · ${formatInt(kpis.alerts.open)} open, ${formatInt(kpis.alerts.acknowledged)} acknowledged`}
      />
      <Tile
        label="Cost this snapshot"
        value={formatUsd(cost)}
        detail={`Snowflake ${formatUsd(kpis.totals.snapshotSnowflakeCostUsd)} · AWS ${formatUsd(kpis.totals.snapshotAwsCostUsd)}`}
      />
    </div>
  );
}

/** Period to date (snapshots 1..N): every figure comes from /sql/09_period_to_date.sql. */
function PeriodTiles({ p, warningSec }: { p: PeriodOverview; warningSec: number | undefined }) {
  const span = `snapshots 1–${p.snapshotCount}`;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <Tile
        label="Refresh success"
        value={p.refreshSuccessRate === null ? '—' : formatPercent(p.refreshSuccessRate)}
        detail={`${formatInt(p.refresh.SUCCESS)} of ${formatInt(p.refreshCount)} refreshes, ${span}`}
      />
      <Tile
        label="Failed + timed out"
        value={formatInt(p.refresh.FAILED + p.refresh.TIMED_OUT)}
        detail={`${formatInt(p.refresh.FAILED)} failed · ${formatInt(p.refresh.TIMED_OUT)} timed out`}
      />
      <Tile
        label="Reports ever orphaned"
        value={formatInt(p.everOrphanedCount)}
        detail={`of ${formatInt(p.reportCount)} had no owner in at least one snapshot`}
      />
      <Tile
        label="Snowflake cost to date"
        value={formatUsd(p.totals.snowflakeCostToDateUsd)}
        detail={`${p.snapshotCount} days${
          p.quarantinedSnapshotCount
            ? ` · ${formatInt(p.quarantinedSnapshotCount)} snapshots with unknown cost left out`
            : ''
        } · AWS (monthly bill) not included`}
      />
      <Tile
        label="Average load time"
        value={formatSeconds(p.avgLoadTimeSec)}
        detail={`Over all ${formatInt(p.refreshCount)} report snapshots`}
      />
      <Tile
        label="p95 load time"
        value={formatSeconds(p.p95LoadTimeSec)}
        detail={
          warningSec
            ? `95% of report snapshots loaded faster · warning at ${warningSec} s`
            : '95% of report snapshots loaded faster'
        }
      />
    </div>
  );
}

function KpiSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-24" />
      ))}
    </div>
  );
}

interface TooltipEntry {
  name?: string | number;
  value?: string | number;
  color?: string;
}
function ChartTooltip({
  active,
  payload,
  title,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  title: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-gray-200 bg-white px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium text-gray-900">{title}</p>
      {payload.map((p) => (
        <p key={String(p.name)} className="flex items-center gap-2 text-gray-700">
          <span className="size-2 rounded-sm" style={{ background: p.color }} aria-hidden />
          {p.name}: <span className="tabular-nums">{p.value}</span>
        </p>
      ))}
    </div>
  );
}

function RefreshTrend({ trend }: { trend: OverviewTrend }) {
  const data = trend.points.map((p) => ({
    ...p.refresh,
    idx: p.snapshotIdx,
    label: String(p.snapshotIdx + 1),
    date: p.snapshotDate,
  }));
  return (
    <>
      <div
        className="h-64"
        role="img"
        aria-label="Stacked bars: refresh status counts per snapshot"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
            <CartesianGrid vertical={false} stroke="#e5e7eb" />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} interval={0} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip
              cursor={{ fill: '#f3f4f6' }}
              content={({ active, payload, label }) => (
                <ChartTooltip
                  active={active}
                  payload={payload as TooltipEntry[]}
                  title={`Snapshot ${String(label)}${
                    Number(label) - 1 > trend.currentIdx ? ' (not reached yet)' : ''
                  }`}
                />
              )}
            />
            <Legend iconType="square" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
            {REFRESH_SERIES.map((s) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stackId="refresh"
                fill={s.color}
                stroke="#ffffff"
                strokeWidth={1}
                isAnimationActive={false}
              >
                {data.map((d) => (
                  <Cell key={d.idx} fillOpacity={d.idx > trend.currentIdx ? 0.3 : 1} />
                ))}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-xs text-gray-500">
        Snapshots after the current one are shown faded: the replay has not reached them.
      </p>
      <details className="mt-2 text-xs text-gray-600">
        <summary className="cursor-pointer">View as table</summary>
        <div className="mt-2 max-h-48 overflow-auto">
          <table className="w-full text-left tabular-nums">
            <thead>
              <tr className="text-gray-500">
                <th className="py-1 font-medium">Snapshot</th>
                {REFRESH_SERIES.map((s) => (
                  <th key={s.key} className="py-1 font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.idx} className="border-t border-gray-100">
                  <td className="py-1">
                    {d.label} · {d.date}
                  </td>
                  {REFRESH_SERIES.map((s) => (
                    <td key={s.key}>{d[s.key]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

function bucketLabel(b: LatencyBucket): string {
  return b.upperSec === null ? `${b.lowerSec}+` : `${b.lowerSec}–${b.upperSec}`;
}

/** Severity colors on bars past the alert thresholds; the rest use the accent. */
function bucketColor(b: LatencyBucket, t: OverviewTrend['thresholds']): string {
  if (b.lowerSec >= t.criticalSec) return '#c93a39';
  if (b.lowerSec >= t.warningSec) return '#d9922b';
  return '#2a78d6';
}

function LatencyDistribution({ trend }: { trend: OverviewTrend }) {
  const data = trend.latency.map((b) => ({ ...b, label: bucketLabel(b) }));
  const total = data.reduce((a, b) => a + b.count, 0);
  if (total === 0) return <EmptyState title="No reports in view" />;
  return (
    <>
      <div className="h-64" role="img" aria-label="Bars: number of reports per load time range">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 16, left: -16 }}>
            <CartesianGrid vertical={false} stroke="#e5e7eb" />
            <XAxis
              dataKey="label"
              tick={AXIS}
              tickLine={false}
              axisLine={false}
              label={{ value: 'Load time (s)', position: 'insideBottom', offset: -12, style: AXIS }}
            />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip
              cursor={{ fill: '#f3f4f6' }}
              content={({ active, payload, label }) => (
                <ChartTooltip
                  active={active}
                  payload={(payload as TooltipEntry[] | undefined)?.map((p) => ({
                    ...p,
                    name: 'Reports',
                  }))}
                  title={`${String(label)} s`}
                />
              )}
            />
            <Bar dataKey="count" radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {data.map((b) => (
                <Cell key={b.lowerSec} fill={bucketColor(b, trend.thresholds)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-xs text-gray-500">
        Amber above {trend.thresholds.warningSec} s (warning), red above{' '}
        {trend.thresholds.criticalSec} s (critical).
      </p>
    </>
  );
}

function TopProblems() {
  const { alerts, tick } = useAlerts();
  if (!tick) return <Skeleton className="h-40" />;
  if (alerts.length === 0) {
    return <EmptyState title="No active alerts" hint="Everything in view is healthy right now." />;
  }
  return (
    <>
      <ol className="divide-y divide-gray-100">
        {alerts.slice(0, TOP_PROBLEMS).map((a) => (
          <li key={a.id} className="flex items-start gap-3 py-2.5">
            <SeverityBadge severity={a.severity} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-gray-900">
                <Link to={`/reports/${a.reportId}`} className="hover:text-accent hover:underline">
                  {a.reportName}
                </Link>{' '}
                <span className="font-normal text-gray-500">{a.reportId}</span>
              </p>
              <p className="truncate text-xs text-gray-600">{a.message}</p>
              <p className="text-xs text-gray-500">
                {a.ownerEmail ?? 'No owner'}
                {a.status === 'ACKNOWLEDGED' && ` · acknowledged by ${a.ackedBy ?? 'a user'}`}
              </p>
            </div>
          </li>
        ))}
      </ol>
      {alerts.length > TOP_PROBLEMS && (
        <p className="mt-2 text-sm">
          <Link to="/alerts" className="text-accent hover:underline">
            View all {alerts.length} active alerts
          </Link>
        </p>
      )}
    </>
  );
}

export default function OverviewPage() {
  const { scope } = useOverviewScope();
  const isPeriod = scope === 'period';
  const overview = useOverview();
  const period = usePeriodOverview(isPeriod);
  const trend = useTrend(scope);
  const kpis = isPeriod ? period : overview;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">Overview</h1>
        {isPeriod
          ? period.data && (
              <p className="text-xs text-gray-500">
                Period to date: snapshots 1–{period.data.snapshotCount} ({period.data.fromDate} to{' '}
                {period.data.toDate})
              </p>
            )
          : overview.data && (
              <p className="text-xs text-gray-500">Snapshot dated {overview.data.snapshotDate}</p>
            )}
      </div>

      {kpis.isPending && <KpiSkeleton />}
      {kpis.isError && (
        <Card>
          <ErrorState message={kpis.error.message} onRetry={() => void kpis.refetch()} />
        </Card>
      )}
      {isPeriod
        ? period.data && (
            <PeriodTiles p={period.data} warningSec={trend.data?.thresholds.warningSec} />
          )
        : overview.data && (
            <KpiTiles kpis={overview.data} warningSec={trend.data?.thresholds.warningSec} />
          )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Refresh status by snapshot" subtitle="Reports per status, all snapshots">
          {trend.isPending && <Skeleton className="h-64" />}
          {trend.isError && (
            <ErrorState message={trend.error.message} onRetry={() => void trend.refetch()} />
          )}
          {trend.data && <RefreshTrend trend={trend.data} />}
        </Card>
        <Card
          title="Load time distribution"
          subtitle={
            isPeriod
              ? `Report snapshots per load-time range, snapshots 1–${(trend.data?.currentIdx ?? 0) + 1}`
              : 'Reports per load-time range, current snapshot'
          }
        >
          {trend.isPending && <Skeleton className="h-64" />}
          {trend.isError && (
            <ErrorState message={trend.error.message} onRetry={() => void trend.refetch()} />
          )}
          {trend.data && <LatencyDistribution trend={trend.data} />}
        </Card>
      </div>

      <Card title="Top problems" subtitle="Most severe active alerts, live">
        <TopProblems />
      </Card>
    </div>
  );
}
