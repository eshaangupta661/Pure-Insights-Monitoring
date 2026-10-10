import {
  alertSchema,
  auditLogEntrySchema,
  auditLogQuerySchema,
  incidentBodySchema,
  replayCommandSchema,
  replayStateSchema,
} from '../api/schemas.js';
import { config } from '../config.js';
import { syncedAlerts } from '../deps.js';
import { HttpError, notFound } from '../http/errors.js';
import { pageSchema } from '../http/pagination.js';
import { defineRoute } from '../http/route.js';
import { IncidentLimitError, type IncidentResult } from '../realtime/engine.js';
import { listAuditLog, recordAudit } from '../repos/audit.js';

export const adminRoutes = [
  defineRoute({
    method: 'get',
    path: '/admin/replay',
    tag: 'admin',
    summary: 'Replay state (admin)',
    access: ['admin'],
    response: replayStateSchema,
    handler: ({ deps }) => deps.clock.state(),
  }),

  defineRoute({
    method: 'post',
    path: '/admin/replay',
    tag: 'admin',
    summary: 'Pause, resume or change the replay speed (admin)',
    description:
      'Moves only the clock’s time anchor, so the tick never jumps and nothing is counted. ' +
      'In memory: a restart resumes at speed 1 from wall time. Audit-logged.',
    access: ['admin'],
    body: replayCommandSchema,
    response: replayStateSchema,
    handler: async ({ deps, user, body }) => {
      await syncedAlerts(deps);
      const saved = deps.clock.save();
      const before = deps.clock.state();
      if (body.action === 'pause') deps.clock.pause();
      else if (body.action === 'resume') deps.clock.resume();
      else deps.clock.setSpeed(body.value);
      const after = deps.clock.state();
      try {
        await recordAudit(deps.warehouse, user, 'REPLAY_CONTROL', 'replay', {
          command: body,
          before: { tick: before.tick, paused: before.paused, speed: before.speed },
          after: { tick: after.tick, paused: after.paused, speed: after.speed },
        });
      } catch (err) {
        // Nothing changes unaudited: put the clock back on its previous timeline.
        deps.clock.restore(saved);
        throw err;
      }
      await syncedAlerts(deps);
      return after;
    },
  }),

  defineRoute({
    method: 'post',
    path: '/admin/incidents',
    tag: 'admin',
    summary: 'Inject a synthetic incident at the current tick (admin)',
    description:
      'LATENCY_SPIKE sets the report’s load time to INCIDENT_LATENCY_SEC (CRITICAL); ' +
      'REFRESH_FAILED sets its refresh status to FAILED. The resulting alert has ' +
      '`synthetic: true` and bypasses the reopen cooldown. Kept in memory for the current ' +
      'replay cycle. Repeating an identical incident at the same tick is a no-op; at most ' +
      `${config.INCIDENTS_MAX_PER_CYCLE} distinct incidents per cycle. Audit-logged.`,
    access: ['admin'],
    status: 201,
    body: incidentBodySchema,
    response: alertSchema,
    errors: {
      404: 'Unknown report',
      429: `RATE_LIMITED: more than ${config.INCIDENTS_MAX_PER_CYCLE} incidents in this replay cycle`,
    },
    handler: async ({ deps, user, body }) => {
      const alerts = await syncedAlerts(deps);
      if (!alerts.hasReport(body.reportId)) throw notFound(`Report ${body.reportId}`);
      let result: IncidentResult;
      try {
        result = alerts.injectIncident(body.reportId, body.kind);
      } catch (err) {
        if (err instanceof IncidentLimitError)
          throw new HttpError(429, 'RATE_LIMITED', err.message);
        throw err;
      }
      const { alert, incident } = result;
      try {
        await recordAudit(deps.warehouse, user, 'INCIDENT_INJECT', body.reportId, {
          kind: body.kind,
          alertId: alert.id,
          // A repeat of an incident already injected at this tick changes nothing.
          duplicate: incident === null,
          ...alerts.position(),
        });
      } catch (err) {
        if (incident) alerts.withdrawIncident(incident);
        throw err;
      }
      return alert;
    },
  }),

  defineRoute({
    method: 'get',
    path: '/admin/audit-log',
    tag: 'admin',
    summary: 'Audit log, newest first (admin)',
    description:
      'Owner overrides, alert acks, replay controls and injected incidents. Stored in the ' +
      'warehouse, so re-running ingest (or a redeploy) clears it.',
    access: ['admin'],
    query: auditLogQuerySchema,
    response: pageSchema(auditLogEntrySchema),
    handler: ({ deps, scope, query }) => listAuditLog(deps.warehouse, scope, query),
  }),
];
