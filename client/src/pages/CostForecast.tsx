import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { CostProjection } from '@pic/shared';
import { api } from '../api/http';
import { PROJECTION_KEY } from '../api/queries';
import { EmptyState, ErrorState, Skeleton, Widget } from '../components/ui';
import { formatShare, formatUsd } from '../lib/format';

const AXIS = { fontSize: 11, fill: '#6b7280' } as const;
/** One hue (the accent): actuals solid, forecast dashed, band soft, future actuals faded. */
const ACCENT = 'var(--color-accent)';
const FADED_OPACITY = 0.35;

export function useCostProjection() {
  return useQuery({
    queryKey: PROJECTION_KEY,
    queryFn: () => api<CostProjection>('/costs/projection'),
    placeholderData: keepPreviousData,
  });
}

interface ChartRow {
  day: number;
  date: string;
  actual: number | null;
  /** Actuals after N, plus N itself so the faded line joins the solid one. */
  future: number | null;
  /** The trend from N onwards (dashed). */
  forecast: number | null;
  band: [number, number] | null;
}

function toRows(p: CostProjection): ChartRow[] {
  const n = p.currentIdx;
  return p.totals.points.map((x) => ({
    day: x.snapshotIdx + 1,
    date: x.snapshotDate,
    actual: x.replayed ? x.actualCostUsd : null,
    future: x.snapshotIdx >= n ? x.actualCostUsd : null,
    forecast: x.snapshotIdx >= n ? x.trendCostUsd : null,
    band:
      x.forecastLowUsd !== null && x.forecastHighUsd !== null
        ? [x.forecastLowUsd, x.forecastHighUsd]
        : null,
  }));
}

function ForecastTooltip({
  active,
  row,
  currentIdx,
}: {
  active?: boolean;
  row?: ChartRow;
  currentIdx: number;
}) {
  if (!active || !row) return null;
  const notYet = row.day - 1 > currentIdx;
  const lines: [string, string][] = [];
  const actual = row.actual ?? (notYet ? row.future : null);
  if (actual !== null)
    lines.push([notYet ? 'Actual (not yet replayed)' : 'Actual', formatUsd(actual)]);
  if (notYet && row.forecast !== null) lines.push(['Forecast', formatUsd(row.forecast)]);
  if (row.band) lines.push(['95% band', `${formatUsd(row.band[0])} – ${formatUsd(row.band[1])}`]);
  return (
    <div className="rounded-md border border-gray-200 bg-white p-2 text-xs shadow-md">
      <p className="mb-1 font-medium text-gray-900">
        Day {row.day} · {row.date}
      </p>
      {lines.map(([k, v]) => (
        <p key={k} className="flex justify-between gap-4 text-gray-700">
          <span>{k}</span>
          <span className="tabular-nums">{v}</span>
        </p>
      ))}
    </div>
  );
}

/** Daily Snowflake cost with the /sql/10 linear trend forecast. */
export function CostForecast() {
  const q = useCostProjection();
  const p = q.data;
  return (
    <Widget
      title="Daily Snowflake cost and forecast"
      subtitle={
        p
          ? `Trend fitted to days 1–${p.currentIdx + 1}; forecast for the rest with a 95% band. Faded: actuals the replay has not reached yet.`
          : undefined
      }
      sql="10_cost_projection.sql"
    >
      {!p ? (
        q.error ? (
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
        ) : (
          <Skeleton className="h-64" />
        )
      ) : p.totals.points.length === 0 ? (
        <EmptyState title="No cost in your scope" />
      ) : (
        <>
          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
            <span>
              Forecast error on days not yet replayed (MAPE):{' '}
              <span className="font-medium text-gray-900 tabular-nums">
                {p.mape === null
                  ? p.holdoutCount === 0
                    ? 'n/a – every day replayed'
                    : 'n/a – needs 2+ days'
                  : formatShare(p.mape)}
              </span>
              {p.holdoutCount > 0 && ` over ${p.holdoutCount} days`}
            </span>
            {p.totals.fit.slopeUsdPerDay !== null && (
              <span>
                Trend:{' '}
                <span className="font-medium text-gray-900 tabular-nums">
                  {p.totals.fit.slopeUsdPerDay >= 0 ? '+' : '−'}
                  {formatUsd(Math.abs(p.totals.fit.slopeUsdPerDay))}/day
                </span>
              </span>
            )}
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={toRows(p)} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="day" tick={AXIS} tickLine={false} axisLine={false} />
                <YAxis
                  tick={AXIS}
                  tickLine={false}
                  axisLine={false}
                  width={64}
                  tickFormatter={(v: number) => formatUsd(v)}
                />
                <Tooltip
                  cursor={{ stroke: '#9ca3af', strokeWidth: 1 }}
                  content={({ active, payload }) => (
                    <ForecastTooltip
                      active={active}
                      row={payload?.[0]?.payload as ChartRow | undefined}
                      currentIdx={p.currentIdx}
                    />
                  )}
                />
                <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
                <Area
                  dataKey="band"
                  name="95% band"
                  stroke="none"
                  fill={ACCENT}
                  fillOpacity={0.12}
                  isAnimationActive={false}
                  legendType="square"
                />
                <Line
                  dataKey="future"
                  name="Not yet replayed"
                  stroke={ACCENT}
                  strokeOpacity={FADED_OPACITY}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  dataKey="forecast"
                  name="Forecast"
                  stroke={ACCENT}
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  dataKey="actual"
                  name="Actual"
                  stroke={ACCENT}
                  strokeWidth={2}
                  dot={{ r: 2, fill: ACCENT }}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Simple linear trend on simulated data. Attributed Snowflake cost only; AWS hosting is a
            monthly bill and is not forecast.
          </p>
        </>
      )}
    </Widget>
  );
}
