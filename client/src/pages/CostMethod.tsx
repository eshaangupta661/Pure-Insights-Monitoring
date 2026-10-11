import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CostAssumptions, CostWorkedExample, ViewerCostAssumptions } from '@pic/shared';
import { api } from '../api/http';
import { ASSUMPTIONS_KEY } from '../api/queries';
import { ErrorState, Skeleton } from '../components/ui';
import { formatInt, formatShare, formatUsd } from '../lib/format';

type Assumptions = CostAssumptions | ViewerCostAssumptions;
const hasExample = (a: Assumptions): a is CostAssumptions => 'example' in a;

/** The example traces small numbers, so show more precision than the tables do. */
const precise = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const cr = (v: number) => `${precise.format(v)} cr`;
const usd4 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

function Step({
  n,
  title,
  formula,
  children,
}: {
  n: number;
  title: string;
  formula: string;
  children?: ReactNode;
}) {
  return (
    <li className="grid gap-1 sm:grid-cols-[12rem_1fr]">
      <p className="text-sm font-medium text-gray-900">
        <span className="mr-1.5 text-gray-400 tabular-nums">{n}.</span>
        {title}
      </p>
      <div>
        <p className="font-mono text-xs text-gray-700">{formula}</p>
        {children && <p className="mt-0.5 font-mono text-xs text-accent-strong">{children}</p>}
      </div>
    </li>
  );
}

function Flow() {
  const stages = ['Warehouse hour', 'Query', 'Report', 'Owner'];
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Attribution flow">
      {stages.map((s, i) => (
        <li key={s} className="flex items-center gap-1.5">
          <span className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1 font-medium text-gray-800">
            {s}
          </span>
          {i < stages.length - 1 && <ChevronRight className="size-3.5 text-gray-400" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

function Steps({ a, e }: { a: Assumptions; e: CostWorkedExample | null }) {
  const p = a.params;
  const h = e?.queryHour ?? null;
  return (
    <ol className="space-y-3">
      <Step
        n={1}
        title="Warehouse hour → query"
        formula="query credits = hour's metered credits × query exec ms in hour ÷ Σ exec ms of all queries in that hour"
      >
        {h &&
          `${cr(h.hourMeteredCredits)} × ${formatInt(h.execMsInHour)} ms ÷ ${formatInt(h.hourExecMs)} ms = ${cr(h.attributedCredits)}  (${h.queryId}, ${h.warehouseName}, hour ${h.hourStart})`}
      </Step>
      <Step
        n={2}
        title="Query → report (one day)"
        formula={`report credits = Σ credits of the day's queries tagged {"report_id"}; active = credits ÷ (1 + ${p.simulatedOverheadRate}), overhead = the rest`}
      >
        {e &&
          `${formatInt(e.queryCount)} queries → ${cr(e.attributedCredits)} = ${cr(e.activeCredits)} active + ${cr(e.overheadCredits)} overhead`}
      </Step>
      <Step
        n={3}
        title="Credits → dollars"
        formula={`daily Snowflake cost = credits × ${formatUsd(p.creditPriceUsd)}; 30-day cost = daily × ${p.daysPerMonth}`}
      >
        {e &&
          `${cr(e.attributedCredits)} × ${formatUsd(p.creditPriceUsd)} = ${usd4.format(e.snowflakeCostUsd)};  × ${p.daysPerMonth} = ${formatUsd(e.snowflakeCost30dUsd)}`}
      </Step>
      <Step
        n={4}
        title="Cost per view"
        formula="fully loaded per view = (30-day Snowflake cost + monthly AWS hosting) ÷ monthly active views"
      >
        {e &&
          `(${formatUsd(e.snowflakeCost30dUsd)} + ${formatUsd(e.awsCostUsd)}) ÷ ${formatInt(e.views)} views = ${
            e.fullyLoadedCostPerView === null ? 'n/a' : usd4.format(e.fullyLoadedCostPerView)
          }`}
      </Step>
      <Step
        n={5}
        title="Report → owner"
        formula="chargeback: each report's cost goes to its current owner (or to the owner at each snapshot); no owner → UNOWNED"
      >
        {e && `${e.reportId} → ${e.currentOwner ?? 'UNOWNED'}`}
      </Step>
    </ol>
  );
}

/** Collapsible "How this is calculated": flow, formulas, a worked example and every assumption. */
export function CostMethod() {
  const q = useQuery({
    queryKey: ASSUMPTIONS_KEY,
    queryFn: () => api<Assumptions>('/costs/assumptions'),
    placeholderData: keepPreviousData,
  });
  const a = q.data;
  const e = a && hasExample(a) ? a.example : null;

  return (
    <details className="group rounded-lg border border-gray-200 bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-2 p-4 text-sm font-medium text-gray-900 select-none">
        <ChevronRight
          className="size-4 text-gray-500 transition-transform group-open:rotate-90"
          aria-hidden
        />
        How this is calculated
        <span className="font-normal text-gray-500">· warehouse hour → query → report → owner</span>
      </summary>
      <div className="space-y-4 border-t border-gray-100 p-4">
        {!a ? (
          q.error ? (
            <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
          ) : (
            <Skeleton className="h-40" />
          )
        ) : (
          <>
            <Flow />
            <div>
              <h3 className="mb-2 text-xs font-medium text-gray-500">
                {e
                  ? `Formulas, with a worked example: ${e.reportName} (${e.reportId}) on day ${e.snapshotIdx + 1} (${e.snapshotDate}), the most expensive report in your view that day`
                  : 'Formulas'}
              </h3>
              <Steps a={a} e={e} />
              {!hasExample(a) && (
                <p className="mt-2 text-xs text-gray-500">
                  The worked example uses one report’s cost, which is visible to admins and owners.
                </p>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-xs font-medium text-gray-500">Assumptions</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
                <li>
                  Credit price: <b>{formatUsd(a.params.creditPriceUsd)}</b> per Snowflake credit (an
                  assumption; roughly Enterprise on-demand).
                </li>
                <li>
                  Overhead: metered credits are query credits ×{' '}
                  <b>(1 + {formatShare(a.params.simulatedOverheadRate)})</b>. This overhead is
                  synthetic (the simulator adds it), not measured idle time; it is spread over each
                  hour’s queries by the same execution-time share.
                </li>
                <li>
                  One snapshot = <b>{a.params.snapshotDays} day</b>: its credits are that day’s
                  spend. Monthly figures scale daily cost by <b>{a.params.daysPerMonth} days</b>.
                </li>
                <li>AWS hosting is taken as a monthly bill, so it is added as is (not × days).</li>
                <li>
                  Zombie reports: fewer than <b>{formatInt(a.params.costLowViews)}</b> monthly views
                  at a snapshot. Estimated savings if retired = that snapshot’s Snowflake cost ×{' '}
                  {a.params.daysPerMonth}; orphaned reports (no owner) have no savings, because
                  reassigning does not stop spend.
                </li>
                <li>
                  Cost mismatch (DQ04): fewer than {formatInt(a.params.costLowViews)} views with AWS
                  over {formatUsd(a.params.costHighAwsUsd)}, or a robust z-score of AWS per view
                  above {a.params.costRobustZ}.
                </li>
                <li>
                  Negative credits are quarantined (DQ02): that snapshot’s Snowflake cost is unknown
                  and left out, never counted as 0. Zero-view snapshots have no cost per view.
                </li>
              </ul>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
