import {
  dataQualitySchema,
  overviewQuerySchema,
  overviewResponseSchema,
  overviewTrendSchema,
  ownerOverrideBodySchema,
  reportDetailSchema,
  reportIdParamsSchema,
  reportSummarySchema,
  reportsQuerySchema,
  viewerReportDetailSchema,
  viewerReportSummarySchema,
} from '../api/schemas.js';
import { notFound } from '../http/errors.js';
import { pageSchema } from '../http/pagination.js';
import { defineRoute } from '../http/route.js';
import { getDataQuality } from '../repos/dataQuality.js';
import { getOverviewTrend, getPeriodOverview } from '../repos/overview.js';
import { setOwnerOverride } from '../repos/owners.js';
import { getReport, listReports } from '../repos/reports.js';

const SCOPE_NOTE =
  'Owners see only reports whose current owner is their email (filtered in SQL). ' +
  'Viewers get the same rows without cost fields.';

export const reportRoutes = [
  defineRoute({
    method: 'get',
    path: '/overview',
    tag: 'reports',
    summary: 'KPIs for the replay snapshot, or period to date',
    description:
      `${SCOPE_NOTE} \`scope=today\` (default): the replay's snapshot N, with \`alerts\` ` +
      'counting active (OPEN + ACKNOWLEDGED) alerts in scope. `scope=period`: snapshots 0..N ' +
      '(/sql/09_period_to_date.sql): refresh success rate, failed and timed-out refreshes, ' +
      'reports ever orphaned, Snowflake cost to date, average and p95 load time. `totals` ' +
      'are aggregates, so every role sees them.',
    access: 'authenticated',
    query: overviewQuerySchema,
    response: overviewResponseSchema,
    viewerResponse: overviewResponseSchema,
    handler: async ({ deps, scope, query }) => {
      if (query.scope === 'today') return deps.realtime.overview(scope);
      await deps.realtime.sync(); // same tick as the rest of the app
      return getPeriodOverview(deps.warehouse, scope, deps.clock.tick());
    },
  }),

  defineRoute({
    method: 'get',
    path: '/overview/trend',
    tag: 'reports',
    summary: 'Refresh-status trend and load-time histogram',
    description:
      `${SCOPE_NOTE} \`points\` has one entry per snapshot (all of them, so the client can show ` +
      'where the replay is); `latency` is the load-time histogram of snapshot N ' +
      '(`scope=today`, default) or of snapshots 0..N (`scope=period`).',
    access: 'authenticated',
    query: overviewQuerySchema,
    response: overviewTrendSchema,
    viewerResponse: overviewTrendSchema,
    handler: ({ deps, scope, query }) =>
      getOverviewTrend(deps.warehouse, scope, deps.clock.tick(), query.scope),
  }),

  defineRoute({
    method: 'get',
    path: '/reports',
    tag: 'reports',
    summary: 'Reports at the current replay snapshot',
    description: `${SCOPE_NOTE} Sorted by \`sort\`/\`order\`, then report id.`,
    access: 'authenticated',
    query: reportsQuerySchema,
    response: pageSchema(reportSummarySchema),
    viewerResponse: pageSchema(viewerReportSummarySchema),
    handler: ({ deps, scope, query }) =>
      listReports(deps.warehouse, scope, deps.clock.tick(), query),
  }),

  defineRoute({
    method: 'get',
    path: '/reports/:id',
    tag: 'reports',
    summary: 'One report: 20-snapshot history, owner history, DQ flags, cost',
    description: `${SCOPE_NOTE} A report outside the caller's scope is 404, not 403, so its existence isn't revealed.`,
    access: 'authenticated',
    params: reportIdParamsSchema,
    response: reportDetailSchema,
    viewerResponse: viewerReportDetailSchema,
    errors: { 404: 'No such report in your scope' },
    handler: async ({ deps, scope, params }) => {
      const report = await getReport(deps.warehouse, scope, deps.clock.tick(), params.id);
      if (!report) throw notFound(`Report ${params.id}`);
      return report;
    },
  }),

  defineRoute({
    method: 'patch',
    path: '/reports/:id/owner',
    tag: 'reports',
    summary: 'Reassign a report’s owner (admin)',
    description:
      'Writes OWNER_OVERRIDES and an AUDIT_LOG row in one transaction. `ownerEmail: null` marks ' +
      'the report orphaned. Ownership-dependent views (current-owner chargeback, zombies, owner ' +
      'scoping, the report’s alerts) follow immediately; ingest-time results are unchanged.',
    access: ['admin'],
    params: reportIdParamsSchema,
    body: ownerOverrideBodySchema,
    response: reportDetailSchema,
    errors: { 404: 'Unknown report' },
    handler: async ({ deps, user, scope, params, body }) => {
      const change = await setOwnerOverride(deps.warehouse, scope, user, params.id, body);
      if (!change) throw notFound(`Report ${params.id}`);
      // Alerts resolve their owner at read time, so this moves the report's alerts too, and
      // every socket room gets a fresh scoped snapshot. The override is already committed: if
      // the refresh fails, it isn't reported as a failure; the next sync retries it.
      await deps.realtime.ownersChanged();
      const report = await getReport(deps.warehouse, scope, deps.clock.tick(), params.id);
      if (!report) throw notFound(`Report ${params.id}`);
      return report;
    },
  }),

  defineRoute({
    method: 'get',
    path: '/data-quality',
    tag: 'data-quality',
    summary: 'DQ rule results',
    description:
      'Counts over every snapshot of the reports in scope (all 100 reports unless the caller is an ' +
      'owner). `checks` is the SQL-vs-TypeScript verification from /sql/02.',
    access: 'authenticated',
    response: dataQualitySchema,
    viewerResponse: dataQualitySchema,
    handler: ({ deps, scope }) => getDataQuality(deps.warehouse, scope),
  }),
];
