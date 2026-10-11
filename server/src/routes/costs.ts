import {
  anomalyReportSchema,
  chargebackQuerySchema,
  chargebackRowSchema,
  chargebackTotalsSchema,
  costAssumptionsSchema,
  costProjectionSchema,
  costReportsQuerySchema,
  costReportsTotalsSchema,
  costRowSchema,
  pageWithTotalsSchema,
  unitEconomicsQuerySchema,
  unitEconomicsRowSchema,
  unitEconomicsTotalsSchema,
  viewerAnomalyReportSchema,
  viewerChargebackRowSchema,
  viewerCostAssumptionsSchema,
  viewerCostRowSchema,
  viewerUnitEconomicsRowSchema,
} from '../api/schemas.js';
import { HttpError } from '../http/errors.js';
import { defineRoute } from '../http/route.js';
import { orderByFor, type SortSpec } from '../http/sort.js';
import {
  getAnomalies,
  getCostAssumptions,
  getCostProjection,
  listChargeback,
  listCostReports,
  listUnitEconomics,
} from '../repos/costs.js';

const COST_NOTE =
  'Owners see only their reports (filtered in SQL); shares are over the rows in the caller’s ' +
  'scope. Viewers get rows without money or credits, plus the `totals` aggregates, and may not ' +
  'sort by cost (403).';

const costReportsSort: SortSpec<'cost' | 'queries' | 'reportId'> = {
  columns: { cost: '"attributedCredits"', queries: '"queryCount"', reportId: '"reportId"' },
  defaultOrder: { cost: 'desc', queries: 'desc', reportId: 'asc' },
  costKeys: ['cost'],
  defaultKey: 'cost',
  viewerDefaultKey: 'reportId',
  tieBreak: '"reportId" ASC',
};

const unitEconomicsSort: SortSpec<'costPerView' | 'reportId'> = {
  columns: { costPerView: '"fullyLoadedCostPerView"', reportId: '"reportId"' },
  defaultOrder: { costPerView: 'desc', reportId: 'asc' },
  costKeys: ['costPerView'],
  defaultKey: 'costPerView',
  viewerDefaultKey: 'reportId',
  tieBreak: '"reportId" ASC',
};

const chargebackSort: SortSpec<'cost' | 'owner'> = {
  columns: { cost: '"totalCostUsd"', owner: 'owner' },
  defaultOrder: { cost: 'desc', owner: 'asc' },
  costKeys: ['cost'],
  defaultKey: 'cost',
  viewerDefaultKey: 'owner',
  tieBreak: 'owner ASC',
};

export const costRoutes = [
  defineRoute({
    method: 'get',
    path: '/costs/reports',
    tag: 'costs',
    summary: 'Attributed Snowflake cost per report (/sql/04)',
    description: `${COST_NOTE} Unscoped callers also get the always-present UNATTRIBUTED line.`,
    access: 'authenticated',
    query: costReportsQuerySchema,
    response: pageWithTotalsSchema(costRowSchema, costReportsTotalsSchema),
    errors: { 403: 'FORBIDDEN: a viewer asked for a cost sort' },
    viewerResponse: pageWithTotalsSchema(viewerCostRowSchema, costReportsTotalsSchema),
    handler: ({ deps, user, scope, query }) =>
      listCostReports(
        deps.warehouse,
        scope,
        orderByFor(costReportsSort, user, query.sort, query.order),
        query,
      ),
  }),

  defineRoute({
    method: 'get',
    path: '/costs/unit-economics',
    tag: 'costs',
    summary: 'Cost per active view per report, Snowflake-only and fully loaded (/sql/05)',
    description: `${COST_NOTE} Zero-view and quarantined snapshots have NULL unit cost.`,
    access: 'authenticated',
    query: unitEconomicsQuerySchema,
    response: pageWithTotalsSchema(unitEconomicsRowSchema, unitEconomicsTotalsSchema),
    errors: { 403: 'FORBIDDEN: a viewer asked for a cost sort' },
    viewerResponse: pageWithTotalsSchema(viewerUnitEconomicsRowSchema, unitEconomicsTotalsSchema),
    handler: ({ deps, user, scope, query }) =>
      listUnitEconomics(
        deps.warehouse,
        scope,
        orderByFor(unitEconomicsSort, user, query.sort, query.order),
        query,
      ),
  }),

  defineRoute({
    method: 'get',
    path: '/costs/anomalies',
    tag: 'costs',
    summary: 'Cost anomalies (/sql/06)',
    description:
      `${COST_NOTE} Short, bounded sections (not paginated): per-view cost outliers; orphaned ` +
      'reports (no owner at the replay snapshot, any usage: reassign) and zombie reports ' +
      '(views below COST_LOW_VIEWS at the replay snapshot, owned or not: retire), both live so ' +
      'owner overrides apply; AWS-vs-views mismatches (DQ04); and quarantined negative-credit ' +
      'snapshots (DQ02). Estimated savings come only from zombies; `totals` sums them. Admins ' +
      'and owners get each section most severe first; viewers get them by report and snapshot, ' +
      'without z-scores or money, since the order or a z-score would reveal per-report cost ranks.',
    access: 'authenticated',
    response: anomalyReportSchema,
    viewerResponse: viewerAnomalyReportSchema,
    handler: ({ deps, user, scope }) =>
      getAnomalies(
        deps.warehouse,
        scope,
        deps.clock.tick(),
        user.role === 'viewer' ? 'neutral' : 'severity',
      ),
  }),

  defineRoute({
    method: 'get',
    path: '/costs/chargeback',
    tag: 'costs',
    summary: 'Cost per owner (/sql/07)',
    description:
      '`view=point_in_time` charges each snapshot to that snapshot’s owner; `view=current` ' +
      'charges a report’s whole history to its current owner (live: follows overrides). ' +
      'point_in_time is an accounting view for admins (viewers get its redacted counts); owners ' +
      'get only `current` (their default), and `view=point_in_time` is 403 for them, because ' +
      'their past-snapshot charges include reports they no longer own. Owners see only their ' +
      'own line; unscoped callers also get UNOWNED and UNATTRIBUTED. Viewers get report and ' +
      'snapshot counts per owner, plus totals.',
    access: 'authenticated',
    query: chargebackQuerySchema,
    response: pageWithTotalsSchema(chargebackRowSchema, chargebackTotalsSchema),
    errors: {
      403: 'FORBIDDEN: a viewer asked for a cost sort, or an owner asked for view=point_in_time',
    },
    viewerResponse: pageWithTotalsSchema(viewerChargebackRowSchema, chargebackTotalsSchema),
    handler: ({ deps, user, scope, query }) => {
      const view = query.view ?? (user.role === 'owner' ? 'current' : 'point_in_time');
      if (user.role === 'owner' && view === 'point_in_time') {
        throw new HttpError(
          403,
          'FORBIDDEN',
          'Point-in-time chargeback is admin-only; owners can use view=current',
        );
      }
      return listChargeback(
        deps.warehouse,
        scope,
        view,
        orderByFor(chargebackSort, user, query.sort, query.order),
        query,
      );
    },
  }),

  defineRoute({
    method: 'get',
    path: '/costs/assumptions',
    tag: 'costs',
    summary: 'How cost is calculated: PARAMS and a worked example (/sql/00, 03–05)',
    description:
      'The PARAMS values the suite ran with (credit price, simulated overhead rate, days per ' +
      'month, low-views threshold, …) plus a worked example: the most expensive report in the ' +
      'caller’s scope at the replay’s snapshot, followed from one warehouse-hour allocation ' +
      '(/sql/03) to its daily and 30-day cost (/sql/04–05). `example` is null when nothing in ' +
      'scope has known cost and views. Viewers get the parameters only (no per-report example).',
    access: 'authenticated',
    response: costAssumptionsSchema,
    viewerResponse: viewerCostAssumptionsSchema,
    handler: ({ deps, scope }) => getCostAssumptions(deps.warehouse, scope, deps.clock.tick()),
  }),

  defineRoute({
    method: 'get',
    path: '/costs/projection',
    tag: 'costs',
    summary: 'Daily Snowflake cost with a linear trend forecast (/sql/10)',
    description:
      'Daily attributed Snowflake cost over the caller’s scope (the portfolio, or an owner’s ' +
      'own reports, filtered in SQL). A least-squares line is fitted to snapshots 0..N (N = ' +
      '`currentIdx`, the replay’s snapshot) and forecast for N+1..last with a ±1.96σ band. ' +
      'Points after N are actuals not yet replayed (show them faded); `mape` scores the ' +
      'forecast against them. `projectedMonthEndUsd` = cost to date + run rate × remaining ' +
      'days of a `daysPerMonth` month. Aggregates only, so viewers get the same body.',
    access: 'authenticated',
    response: costProjectionSchema,
    viewerResponse: costProjectionSchema,
    handler: ({ deps, scope }) => getCostProjection(deps.warehouse, scope, deps.clock.tick()),
  }),
];
