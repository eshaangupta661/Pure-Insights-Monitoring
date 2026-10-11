import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type {
  AnomalyReport,
  ChargebackRow,
  ChargebackTotals,
  ChargebackView,
  CostReportsTotals,
  CostRow,
  PageWithTotals,
  UnitEconomicsRow,
  UnitEconomicsTotals,
  ViewerAnomalyReport,
  ViewerChargebackRow,
  ViewerCostRow,
  ViewerUnitEconomicsRow,
  ViewerZombieReport,
  ZombieReport,
} from '@pic/shared';
import { api } from '../api/http';
import { useAuth } from '../auth/AuthProvider';
import {
  EmptyState,
  ErrorState,
  Pagination,
  Skeleton,
  Widget,
  controlClass,
} from '../components/ui';
import { formatCredits, formatInt, formatShare, formatUsd } from '../lib/format';

const COST_PAGE_SIZE = 10;
const CHARGEBACK_PAGE_SIZE = 100;
const COST_KEY = ['costs'] as const;

const hasMoney = <T extends object>(row: T): row is T & { attributedCostUsd: number } =>
  'attributedCostUsd' in row;

/** Per-view costs are often cents, so keep three decimals below $10. */
const perView = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});
const formatPerView = (v: number): string => perView.format(v);

type Redactable = ZombieReport | ViewerZombieReport;
const zombieHasMoney = (z: Redactable): z is ZombieReport => 'estimatedMonthlySavingsUsd' in z;

function Tile({ label, value, detail }: { label: string; value: string; detail: ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900 tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-gray-500">{detail}</p>
    </div>
  );
}

function Loading({ error, onRetry }: { error?: Error | null; onRetry: () => void }) {
  return error ? (
    <ErrorState message={error.message} onRetry={onRetry} />
  ) : (
    <Skeleton className="h-40" />
  );
}

const th = 'py-2 pr-3 font-medium';
const NA_ZERO_VIEWS = 'n/a – 0 views';

function UnitCost({ value, row }: { value: number | null; row: UnitEconomicsRow }) {
  if (value !== null) return <>{formatPerView(value)}</>;
  const reason = row.costedViews === 0 ? NA_ZERO_VIEWS : 'n/a – no costed snapshot';
  return <span className="text-gray-500">{reason}</span>;
}

// ---- widgets -----------------------------------------------------------------------------

function ReportCosts({ moneyVisible }: { moneyVisible: boolean }) {
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: [...COST_KEY, 'reports', page],
    queryFn: () =>
      api<PageWithTotals<CostRow | ViewerCostRow, CostReportsTotals>>(
        `/costs/reports?page=${page}&pageSize=${COST_PAGE_SIZE}`,
      ),
    placeholderData: keepPreviousData,
  });
  const maxShare = Math.max(
    0,
    ...(q.data?.items.map((r) => ('shareOfTotal' in r ? (r.shareOfTotal ?? 0) : 0)) ?? []),
  );
  return (
    <Widget
      title="Cost by report"
      subtitle={
        moneyVisible
          ? 'Attributed Snowflake credits and dollars over all snapshots, highest first'
          : 'Which reports exist and how busy they are'
      }
      sql="04_report_attribution.sql"
    >
      {q.data ? (
        q.data.items.length === 0 ? (
          <EmptyState title="No cost lines in your scope" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <thead className="border-b border-gray-200 text-left text-xs text-gray-500">
                  <tr>
                    <th className={th}>Report</th>
                    <th className={th}>Owner</th>
                    <th className={`${th} text-right`}>Queries</th>
                    {moneyVisible && (
                      <>
                        <th className={`${th} text-right`}>Credits</th>
                        <th className={`${th} text-right`}>Cost</th>
                        <th className={`${th} w-32`}>Share</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {q.data.items.map((r) => (
                    <tr key={r.reportId}>
                      <td className="py-2 pr-3">
                        {r.reportId === 'UNATTRIBUTED' ? (
                          <span
                            className="font-medium text-gray-900"
                            title="Metered spend not tagged to any report"
                          >
                            Unattributed spend
                          </span>
                        ) : (
                          <Link
                            to={`/reports/${r.reportId}`}
                            className="hover:text-accent hover:underline"
                          >
                            <span className="font-medium text-gray-900">{r.reportName}</span>{' '}
                            <span className="text-gray-500">{r.reportId}</span>
                          </Link>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-gray-700">
                        {r.currentOwner ?? <span className="text-gray-500 italic">No owner</span>}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatInt(r.queryCount)}
                      </td>
                      {moneyVisible && hasMoney(r) && 'attributedCredits' in r && (
                        <>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {formatCredits((r as CostRow).attributedCredits)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {formatUsd(r.attributedCostUsd)}
                          </td>
                          <td className="py-2">
                            <ShareBar share={(r as CostRow).shareOfTotal} max={maxShare} />
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={q.data.page}
              pageSize={q.data.pageSize}
              total={q.data.total}
              onPage={setPage}
            />
          </>
        )
      ) : (
        <Loading error={q.error} onRetry={() => void q.refetch()} />
      )}
    </Widget>
  );
}

/** Bar length is relative to the largest share on the page, so small shares stay readable. */
function ShareBar({ share, max }: { share: number | null; max: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 rounded-full bg-gray-100" aria-hidden>
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${max > 0 ? ((share ?? 0) / max) * 100 : 0}%` }}
        />
      </div>
      <span className="w-12 text-right text-xs text-gray-600 tabular-nums">
        {formatShare(share)}
      </span>
    </div>
  );
}

function UnitEconomics({ moneyVisible }: { moneyVisible: boolean }) {
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: [...COST_KEY, 'unit', page],
    queryFn: () =>
      api<PageWithTotals<UnitEconomicsRow | ViewerUnitEconomicsRow, UnitEconomicsTotals>>(
        `/costs/unit-economics?page=${page}&pageSize=${COST_PAGE_SIZE}`,
      ),
    placeholderData: keepPreviousData,
  });
  return (
    <Widget
      title="Cost per view"
      subtitle={
        moneyVisible
          ? 'Cost per monthly active view, highest first. Snowflake-only and fully loaded (with AWS hosting).'
          : 'Reports and how many snapshots each has'
      }
      sql="05_unit_economics.sql"
    >
      {q.data ? (
        q.data.items.length === 0 ? (
          <EmptyState title="No reports in your scope" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <thead className="border-b border-gray-200 text-left text-xs text-gray-500">
                  <tr>
                    <th className={th}>Report</th>
                    <th className={th}>Owner</th>
                    {moneyVisible ? (
                      <>
                        <th className={`${th} text-right`}>Views</th>
                        <th className={`${th} text-right`}>Snowflake / view</th>
                        <th className={`${th} text-right`}>Fully loaded / view</th>
                      </>
                    ) : (
                      <th className={`${th} text-right`}>Snapshots</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {q.data.items.map((r) => (
                    <tr key={r.reportId}>
                      <td className="py-2 pr-3">
                        <Link
                          to={`/reports/${r.reportId}`}
                          className="hover:text-accent hover:underline"
                        >
                          <span className="font-medium text-gray-900">{r.reportName}</span>{' '}
                          <span className="text-gray-500">{r.reportId}</span>
                        </Link>
                      </td>
                      <td className="py-2 pr-3 text-gray-700">
                        {r.currentOwner ?? <span className="text-gray-500 italic">No owner</span>}
                      </td>
                      {'fullyLoadedCostPerView' in r ? (
                        <>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {r.costedViews === null ? '—' : formatInt(r.costedViews)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            <UnitCost value={r.snowflakeCostPerView} row={r} />
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            <UnitCost value={r.fullyLoadedCostPerView} row={r} />
                          </td>
                        </>
                      ) : (
                        <td className="py-2 pr-3 text-right tabular-nums">{r.snapshotCount}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={q.data.page}
              pageSize={q.data.pageSize}
              total={q.data.total}
              onPage={setPage}
            />
            <p className="mt-2 text-xs text-gray-500">
              A report with no views has no cost per view; it shows “{NA_ZERO_VIEWS}” instead of a
              division by zero.
            </p>
          </>
        )
      ) : (
        <Loading error={q.error} onRetry={() => void q.refetch()} />
      )}
    </Widget>
  );
}

const ZOMBIE_REASON: Record<Redactable['reason'], string> = {
  ORPHANED: 'No owner',
  LOW_USAGE: 'Low usage',
  BOTH: 'No owner, low usage',
};

function Zombies({ zombies }: { zombies: Redactable[] }) {
  const priced = zombies.filter(zombieHasMoney);
  const total = priced.reduce((a, z) => a + z.estimatedMonthlySavingsUsd, 0);
  return zombies.length === 0 ? (
    <EmptyState title="No zombie reports" hint="Every report that spends has an owner and users." />
  ) : (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-sm">
          <thead className="border-b border-gray-200 text-left text-xs text-gray-500">
            <tr>
              <th className={th}>Report</th>
              <th className={th}>Why</th>
              <th className={`${th} text-right`}>Views</th>
              {priced.length > 0 && (
                <>
                  <th className={`${th} text-right`}>Latest cost</th>
                  <th className={`${th} text-right`}>Est. savings / month</th>
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {zombies.map((z) => (
              <tr key={z.reportId}>
                <td className="py-2 pr-3">
                  <Link to={`/reports/${z.reportId}`} className="hover:text-accent hover:underline">
                    <span className="font-medium text-gray-900">{z.reportName}</span>{' '}
                    <span className="text-gray-500">{z.reportId}</span>
                  </Link>
                  <span className="block text-xs text-gray-500">
                    {z.currentOwner ?? 'No owner'}
                  </span>
                </td>
                <td className="py-2 pr-3 text-gray-700">{ZOMBIE_REASON[z.reason]}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{formatInt(z.latestViews)}</td>
                {zombieHasMoney(z) && (
                  <>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatUsd(z.latestSnowflakeCostUsd)}
                    </td>
                    <td className="py-2 pr-3 text-right font-medium tabular-nums">
                      {formatUsd(z.estimatedMonthlySavingsUsd)}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
          {priced.length > 0 && (
            <tfoot>
              <tr className="border-t border-gray-200 text-sm font-medium">
                <td colSpan={4} className="py-2 text-right text-gray-700">
                  Total estimated savings / month
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{formatUsd(total)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        A zombie report still spends credits in the latest snapshot but has no owner or almost no
        views. The estimate projects that snapshot’s Snowflake cost (one day) over a month; it
        excludes AWS hosting, so retiring the report may save more.
      </p>
    </>
  );
}

function Chargeback({ role }: { role: 'admin' | 'owner' | 'viewer' }) {
  const [view, setView] = useState<ChargebackView>(role === 'owner' ? 'current' : 'point_in_time');
  const q = useQuery({
    queryKey: [...COST_KEY, 'chargeback', view],
    queryFn: () =>
      api<PageWithTotals<ChargebackRow | ViewerChargebackRow, ChargebackTotals>>(
        `/costs/chargeback?view=${view}&pageSize=${CHARGEBACK_PAGE_SIZE}`,
      ),
    placeholderData: keepPreviousData,
  });
  const maxShare = Math.max(
    0,
    ...(q.data?.items.map((r) => ('shareOfTotalCost' in r ? (r.shareOfTotalCost ?? 0) : 0)) ?? []),
  );
  const LABEL: Record<string, string> = {
    UNOWNED: 'Unowned (no owner)',
    UNATTRIBUTED: 'Unattributed spend',
  };
  return (
    <Widget
      title="Owner chargeback"
      subtitle="Cost per owner, including spend nobody owns"
      sql="07_owner_chargeback.sql"
    >
      {role !== 'owner' && (
        <label className="mb-3 flex items-center gap-2 text-sm text-gray-700">
          Charge each snapshot to
          <select
            className={controlClass}
            value={view}
            onChange={(e) => setView(e.target.value as ChargebackView)}
          >
            <option value="point_in_time">that snapshot’s owner</option>
            <option value="current">the report’s current owner</option>
          </select>
        </label>
      )}
      {q.data ? (
        q.data.items.length === 0 ? (
          <EmptyState title="No chargeback lines in your scope" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="border-b border-gray-200 text-left text-xs text-gray-500">
                <tr>
                  <th className={th}>Owner</th>
                  <th className={`${th} text-right`}>Reports</th>
                  <th className={`${th} text-right`}>Snapshots</th>
                  {q.data.items.some((r) => 'totalCostUsd' in r) && (
                    <>
                      <th className={`${th} text-right`}>Snowflake</th>
                      <th className={`${th} text-right`}>AWS</th>
                      <th className={`${th} text-right`}>Total</th>
                      <th className={`${th} w-32`}>Share</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {q.data.items.map((r) => (
                  <tr key={r.owner}>
                    <td className="py-2 pr-3 text-gray-900">{LABEL[r.owner] ?? r.owner}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatInt(r.reportCount)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatInt(r.snapshotCount)}
                    </td>
                    {'totalCostUsd' in r && (
                      <>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {formatUsd(r.snowflakeCostUsd)}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {formatUsd(r.awsCostUsd)}
                        </td>
                        <td className="py-2 pr-3 text-right font-medium tabular-nums">
                          {formatUsd(r.totalCostUsd)}
                        </td>
                        <td className="py-2">
                          <ShareBar share={r.shareOfTotalCost} max={maxShare} />
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
              {'totalCostUsd' in (q.data.items[0] ?? {}) && (
                <tfoot>
                  <tr className="border-t border-gray-200 font-medium">
                    <td className="py-2" colSpan={3}>
                      Total
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatUsd(q.data.totals.snowflakeCostUsd)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatUsd(q.data.totals.awsCostUsd)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatUsd(q.data.totals.totalCostUsd)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )
      ) : (
        <Loading error={q.error} onRetry={() => void q.refetch()} />
      )}
      <p className="mt-2 text-xs text-gray-500">
        Unowned is spend on snapshots or reports with no owner. Unattributed is metered spend that
        was not tagged to any report; it is never dropped.
      </p>
    </Widget>
  );
}

// ---- page --------------------------------------------------------------------------------

export default function CostPage() {
  const { user } = useAuth();
  const role = user?.role ?? 'viewer';
  const moneyVisible = role !== 'viewer';

  const totals = useQuery({
    queryKey: [...COST_KEY, 'totals'],
    queryFn: async () => {
      const [costs, unit] = await Promise.all([
        api<PageWithTotals<ViewerCostRow, CostReportsTotals>>('/costs/reports?pageSize=1'),
        api<PageWithTotals<ViewerUnitEconomicsRow, UnitEconomicsTotals>>(
          '/costs/unit-economics?pageSize=1',
        ),
      ]);
      return { costs: costs.totals, unit: unit.totals };
    },
  });
  const anomalies = useQuery({
    queryKey: [...COST_KEY, 'anomalies'],
    queryFn: () => api<AnomalyReport | ViewerAnomalyReport>('/costs/anomalies'),
  });

  const zombies: Redactable[] = anomalies.data?.zombies ?? [];
  const savings = zombies
    .filter(zombieHasMoney)
    .reduce((a, z) => a + z.estimatedMonthlySavingsUsd, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">Cost Attribution</h1>
        <p className="text-xs text-gray-500">
          {role === 'viewer'
            ? 'Aggregates only: per-report dollar amounts are visible to admins and owners.'
            : role === 'owner'
              ? 'Cost of the reports you own.'
              : 'Snowflake cost attributed to reports from query logs, plus AWS hosting.'}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {totals.data ? (
          <>
            <Tile
              label="Attributed Snowflake cost"
              value={formatUsd(totals.data.costs.attributedCostUsd)}
              detail={`${formatCredits(totals.data.costs.attributedCredits)} credits · ${formatInt(totals.data.costs.queryCount)} queries`}
            />
            <Tile
              label="AWS hosting cost"
              value={formatUsd(totals.data.unit.awsCostUsd)}
              detail="Over snapshots with known Snowflake credits"
            />
            <Tile
              label="Fully loaded cost per view"
              value={
                totals.data.unit.fullyLoadedCostPerView === null
                  ? NA_ZERO_VIEWS
                  : formatPerView(totals.data.unit.fullyLoadedCostPerView)
              }
              detail={`${formatInt(totals.data.unit.costedViews)} monthly views counted`}
            />
          </>
        ) : (
          Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-24" />)
        )}
        {anomalies.data ? (
          <Tile
            label="Zombie reports"
            value={formatInt(zombies.length)}
            detail={
              moneyVisible
                ? `Est. ${formatUsd(savings)} / month if retired`
                : 'Spending with no owner or users'
            }
          />
        ) : (
          <Skeleton className="h-24" />
        )}
      </div>
      {totals.isError && (
        <ErrorState message={totals.error.message} onRetry={() => void totals.refetch()} />
      )}

      <ReportCosts moneyVisible={moneyVisible} />
      <UnitEconomics moneyVisible={moneyVisible} />
      <Widget
        title="Zombie reports"
        subtitle="Still spending, but nobody owns them or uses them"
        sql="06_anomalies.sql"
      >
        {anomalies.data ? (
          <Zombies zombies={zombies} />
        ) : (
          <Loading error={anomalies.error} onRetry={() => void anomalies.refetch()} />
        )}
      </Widget>
      <Chargeback role={role} />
    </div>
  );
}
