import { alertIdParamsSchema, alertSchema, alertsQuerySchema } from '../api/schemas.js';
import { syncedAlerts } from '../deps.js';
import { HttpError, notFound } from '../http/errors.js';
import { pageSchema, paginateArray } from '../http/pagination.js';
import { defineRoute } from '../http/route.js';
import { recordAudit } from '../repos/audit.js';

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
        (await syncedAlerts(deps)).list(scope, { status: query.status, severity: query.severity }),
        query,
      ),
  }),

  defineRoute({
    method: 'post',
    path: '/alerts/:id/ack',
    tag: 'alerts',
    summary: 'Acknowledge an alert',
    description:
      'OPEN → ACKNOWLEDGED (idempotent if already acknowledged). Owners may ack only alerts on ' +
      'their own reports; others are 404. Audit-logged.',
    access: ['admin', 'owner'],
    params: alertIdParamsSchema,
    response: alertSchema,
    errors: { 404: 'No such alert in your scope', 409: 'The alert is already RESOLVED' },
    handler: async ({ deps, user, scope, params }) => {
      const alerts = await syncedAlerts(deps);
      const result = alerts.ack(params.id, user, scope);
      if (!result.ok) {
        if (result.reason === 'RESOLVED') {
          throw new HttpError(409, 'CONFLICT', `Alert ${params.id} is already resolved`);
        }
        throw notFound(`Alert ${params.id}`);
      }
      if (result.record) {
        // Applied first (synchronously, so no tick can slip in between), then audited; if the
        // audit row can't be written, the ack is withdrawn, so nothing changes unaudited.
        const { reportId, ruleId, severity } = result.alert;
        try {
          await recordAudit(deps.warehouse, user, 'ALERT_ACK', params.id, {
            reportId,
            ruleId,
            severity,
            ...alerts.position(),
          });
        } catch (err) {
          alerts.withdrawAck(result.record);
          throw err;
        }
      }
      return result.alert;
    },
  }),
];
