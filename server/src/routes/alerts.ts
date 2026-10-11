import {
  alertIdParamsSchema,
  alertSchema,
  alertsQuerySchema,
  bulkAckBodySchema,
  bulkAckResultSchema,
} from '../api/schemas.js';
import { syncedAlerts } from '../deps.js';
import { HttpError, notFound } from '../http/errors.js';
import { pageSchema, paginateArray } from '../http/pagination.js';
import { defineRoute } from '../http/route.js';

export const alertRoutes = [
  defineRoute({
    method: 'get',
    path: '/alerts',
    tag: 'alerts',
    summary: 'Alerts of the current replay cycle',
    description:
      'Active first (OPEN, ACKNOWLEDGED, RESOLVED), then most severe, then most recently seen. ' +
      'Owners see alerts for reports they currently own; admins and viewers see all. Alerts are ' +
      'kept in memory and rebuilt from the snapshots, so they reset when the replay wraps to ' +
      'snapshot 0.',
    access: 'authenticated',
    query: alertsQuerySchema,
    response: pageSchema(alertSchema),
    viewerResponse: pageSchema(alertSchema),
    handler: async ({ deps, scope, query }) =>
      paginateArray(
        (await syncedAlerts(deps)).list(scope, {
          status: query.status,
          severity: query.severity,
          resolved: query.resolved,
          q: query.q,
        }),
        query,
      ),
  }),

  defineRoute({
    method: 'post',
    path: '/alerts/ack',
    tag: 'alerts',
    summary: 'Acknowledge several alerts',
    description:
      'Acknowledges up to 200 alerts in one audited step. Each id is handled like ' +
      '`POST /alerts/:id/ack`: OPEN → ACKNOWLEDGED (already acknowledged is a no-op), and an ' +
      'unknown id or one outside your scope is skipped as NOT_FOUND (owners cannot tell the ' +
      'two apart), a RESOLVED one as CONFLICT. Skipped ids never fail the request. One ' +
      '`ALERT_ACK_BULK` audit row covers all changes; if it cannot be written, every ack is ' +
      'withdrawn and the request fails with 500. Each changed alert is broadcast as ' +
      '`alert:updated`.',
    access: ['admin', 'owner'],
    body: bulkAckBodySchema,
    response: bulkAckResultSchema,
    handler: ({ deps, user, body }) => deps.realtime.ackMany(user, body.alertIds),
  }),

  defineRoute({
    method: 'post',
    path: '/alerts/:id/ack',
    tag: 'alerts',
    summary: 'Acknowledge an alert',
    description:
      'OPEN → ACKNOWLEDGED (idempotent if already acknowledged). Owners may ack only alerts on ' +
      'their own reports; others are 404. Audit-logged, then broadcast as `alert:updated`.',
    access: ['admin', 'owner'],
    params: alertIdParamsSchema,
    response: alertSchema,
    errors: { 404: 'No such alert in your scope', 409: 'The alert is already RESOLVED' },
    handler: async ({ deps, user, params }) => {
      // Applied, audited, then broadcast as alert:updated; withdrawn if the audit row fails.
      const result = await deps.realtime.ack(user, params.id);
      if (!result.ok) {
        if (result.reason === 'RESOLVED') {
          throw new HttpError(409, 'CONFLICT', `Alert ${params.id} is already resolved`);
        }
        if (result.reason === 'FORBIDDEN') {
          throw new HttpError(403, 'FORBIDDEN', 'Requires role: admin or owner');
        }
        throw notFound(`Alert ${params.id}`);
      }
      return result.alert;
    },
  }),
];
