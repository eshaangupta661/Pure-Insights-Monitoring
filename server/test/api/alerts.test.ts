import type { Alert, ReplayState } from '@pic/shared';
import request, { type Agent } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { buildTestApp, LATEST_TICK, type TestApp } from '../helpers/app.js';
import { loginAs } from '../helpers/auth.js';

const OWNER = 'user_3@company.com';

/** Alerts, acks, incidents and replay controls over the real data (cycle 1000, tick 19). */
describe('alerts API', () => {
  let t: TestApp;
  let admin: Agent;
  let owner: Agent;
  let viewer: Agent;

  const alertsAs = async (agent: Agent, qs = ''): Promise<Alert[]> => {
    const res = await agent.get(`/api/v1/alerts?pageSize=100${qs}`);
    expect(res.status).toBe(200);
    const items: Alert[] = [...res.body.items];
    for (let page = 2; items.length < res.body.total; page++) {
      items.push(...(await agent.get(`/api/v1/alerts?pageSize=100&page=${page}${qs}`)).body.items);
    }
    return items;
  };
  const auditRows = (action: string) =>
    t.sql<{ target: string; details: string }>(
      `SELECT target, details FROM AUDIT_LOG WHERE action = '${action}' ORDER BY logged_at`,
    );

  beforeAll(async () => {
    t = await buildTestApp();
    [admin, owner, viewer] = await Promise.all([
      loginAs(t.app, 'admin'),
      loginAs(t.app, 'owner'),
      loginAs(t.app, 'viewer'),
    ]);
  }, 60_000);
  afterAll(() => t.close());

  describe('GET /alerts', () => {
    it('admin: alerts of the current cycle replayed from snapshot 0 to 19, active first', async () => {
      const alerts = await alertsAs(admin);
      expect(alerts.length).toBeGreaterThan(0);
      for (const a of alerts) {
        expect(a.id.startsWith(`1000-${a.reportId}-${a.ruleId}-`)).toBe(true);
        expect(a.openedTick).toBeLessThanOrEqual(a.lastSeenTick);
        expect(a.lastSeenTick).toBeLessThanOrEqual(LATEST_TICK);
        expect(a.status === 'RESOLVED').toBe(a.resolvedTick !== undefined);
        expect(a.synthetic).toBe(false);
      }
      const order = { OPEN: 0, ACKNOWLEDGED: 1, RESOLVED: 2 };
      const ranks = alerts.map((a) => order[a.status]);
      expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
      expect(new Set(alerts.map((a) => a.ruleId))).toEqual(
        new Set(['LATENCY', 'REFRESH_FAILED', 'REFRESH_UNKNOWN']),
      );
    });

    it('filters by status and severity; overview counts match the active list', async () => {
      const open = await alertsAs(admin, '&status=OPEN');
      expect(open.every((a) => a.status === 'OPEN')).toBe(true);
      const critical = await alertsAs(admin, '&severity=CRITICAL');
      expect(critical.every((a) => a.severity === 'CRITICAL')).toBe(true);

      const active = (await alertsAs(admin)).filter((a) => a.status !== 'RESOLVED');
      const k = (await admin.get('/api/v1/overview')).body.alerts;
      expect(k.total).toBe(active.length);
      expect(k.CRITICAL).toBe(active.filter((a) => a.severity === 'CRITICAL').length);
      expect((await admin.get('/api/v1/alerts?status=BAD')).status).toBe(400);
    });

    it('resolved=false leaves out RESOLVED alerts; q matches report id or name', async () => {
      const all = await alertsAs(admin);
      const active = await alertsAs(admin, '&resolved=false');
      expect(all.some((x) => x.status === 'RESOLVED')).toBe(true);
      expect(active).toEqual(all.filter((x) => x.status !== 'RESOLVED'));
      expect(await alertsAs(admin, '&resolved=true')).toEqual(all);

      const target = all[0]!;
      const byId = await alertsAs(admin, `&q=${target.reportId.toLowerCase()}`);
      expect(byId.length).toBeGreaterThan(0);
      expect(byId.every((x) => x.reportId === target.reportId)).toBe(true);
      const byName = await alertsAs(admin, `&q=${encodeURIComponent(target.reportName)}`);
      expect(byName.some((x) => x.id === target.id)).toBe(true);
      expect(await alertsAs(admin, '&q=no-such-report')).toEqual([]);
    });

    it('owner: only alerts on reports they currently own; viewer: all, read-only', async () => {
      const all = await alertsAs(admin);
      const mine = await alertsAs(owner);
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.every((a) => a.ownerEmail === OWNER)).toBe(true);
      expect(mine.map((a) => a.id).sort()).toEqual(
        all
          .filter((a) => a.ownerEmail === OWNER)
          .map((a) => a.id)
          .sort(),
      );
      expect((await owner.get('/api/v1/overview')).body.alerts.total).toBe(
        mine.filter((a) => a.status !== 'RESOLVED').length,
      );
      expect(await alertsAs(viewer)).toEqual(all);
    });
  });

  describe('POST /alerts/:id/ack', () => {
    it('owner acks their own OPEN alert (audit-logged once); repeat is a no-op 200', async () => {
      const target = (await alertsAs(owner, '&status=OPEN'))[0]!;
      const res = await owner.post(`/api/v1/alerts/${target.id}/ack`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: target.id, status: 'ACKNOWLEDGED', ackedBy: OWNER });
      expect((await owner.post(`/api/v1/alerts/${target.id}/ack`)).status).toBe(200);
      const audit = await auditRows('ALERT_ACK');
      expect(audit.map((r) => r.target)).toEqual([target.id]);
      expect(JSON.parse(audit[0]!.details)).toMatchObject({
        reportId: target.reportId,
        tick: LATEST_TICK,
      });
    });

    it('owner gets 404 for someone else’s alert; admin can ack it', async () => {
      const foreign = (await alertsAs(admin, '&status=OPEN')).find((a) => a.ownerEmail !== OWNER)!;
      expect((await owner.post(`/api/v1/alerts/${foreign.id}/ack`)).status).toBe(404);
      const res = await admin.post(`/api/v1/alerts/${foreign.id}/ack`);
      expect(res.body).toMatchObject({ status: 'ACKNOWLEDGED', ackedBy: 'admin@pureinsights.dev' });
    });

    it('409 for a resolved alert, 404 for an unknown id, 403 viewer, 401 anonymous', async () => {
      const resolved = (await alertsAs(admin, '&status=RESOLVED'))[0]!;
      const conflict = await admin.post(`/api/v1/alerts/${resolved.id}/ack`);
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe('CONFLICT');
      expect((await admin.post('/api/v1/alerts/1000-RPT_999-LATENCY-0/ack')).status).toBe(404);
      expect((await viewer.post(`/api/v1/alerts/${resolved.id}/ack`)).status).toBe(403);
      expect((await request(t.app).post(`/api/v1/alerts/${resolved.id}/ack`)).status).toBe(401);
    });
  });

  describe('POST /admin/incidents', () => {
    it('opens (or escalates to) a CRITICAL synthetic alert the owner sees; audit-logged', async () => {
      const { id } = (
        await t.sql<{ id: string }>(
          `SELECT report_id AS id FROM REPORTS WHERE current_owner = '${OWNER}' ORDER BY report_id LIMIT 1`,
        )
      )[0]!;
      const res = await admin
        .post('/api/v1/admin/incidents')
        .send({ reportId: id, kind: 'REFRESH_FAILED' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        reportId: id,
        ruleId: 'REFRESH_FAILED',
        severity: 'CRITICAL',
        ownerEmail: OWNER,
      });
      expect(res.body.status).not.toBe('RESOLVED');
      expect((await alertsAs(owner)).map((a) => a.id)).toContain(res.body.id);
      expect((await auditRows('INCIDENT_INJECT')).map((r) => r.target)).toEqual([id]);

      // A LATENCY alert already active for the key is escalated; otherwise a synthetic one opens.
      const prior = (await alertsAs(admin)).find(
        (a) => a.reportId === id && a.ruleId === 'LATENCY' && a.status !== 'RESOLVED',
      );
      const spike = await admin
        .post('/api/v1/admin/incidents')
        .send({ reportId: id, kind: 'LATENCY_SPIKE' });
      expect(spike.body).toMatchObject({ ruleId: 'LATENCY', severity: 'CRITICAL' });
      if (prior) expect(spike.body.id).toBe(prior.id);
      else expect(spike.body).toMatchObject({ synthetic: true, openedTick: LATEST_TICK });
    });

    it('404 unknown report, 400 bad kind, 403 for owner', async () => {
      expect(
        (
          await admin
            .post('/api/v1/admin/incidents')
            .send({ reportId: 'RPT_999', kind: 'LATENCY_SPIKE' })
        ).status,
      ).toBe(404);
      expect(
        (await admin.post('/api/v1/admin/incidents').send({ reportId: 'RPT_203', kind: 'METEOR' }))
          .status,
      ).toBe(400);
      expect(
        (
          await owner
            .post('/api/v1/admin/incidents')
            .send({ reportId: 'RPT_203', kind: 'LATENCY_SPIKE' })
        ).status,
      ).toBe(403);
    });
  });

  describe('owner override moves alerts', () => {
    it('after PATCH, the report’s alerts leave the old owner’s list and join the new one’s', async () => {
      const moved = (await alertsAs(owner))[0]!;
      const res = await admin
        .patch(`/api/v1/reports/${moved.reportId}/owner`)
        .send({ ownerEmail: 'someone.else@company.com' });
      expect(res.status).toBe(200);
      expect((await alertsAs(owner)).some((a) => a.reportId === moved.reportId)).toBe(false);
      const all = await alertsAs(admin);
      expect(all.find((a) => a.id === moved.id)?.ownerEmail).toBe('someone.else@company.com');
    });
  });

  describe('nothing changes unaudited (security review L2)', () => {
    /** Runs `fn` with AUDIT_LOG unavailable, so every audit insert fails. */
    const withAuditDown = async (fn: () => Promise<void>) => {
      await t.db.conn.run('ALTER TABLE AUDIT_LOG RENAME TO AUDIT_LOG_OFFLINE');
      try {
        await fn();
      } finally {
        await t.db.conn.run('ALTER TABLE AUDIT_LOG_OFFLINE RENAME TO AUDIT_LOG');
      }
    };

    it('ack: 500 and the alert stays OPEN', async () => {
      const target = (await alertsAs(admin, '&status=OPEN'))[0]!;
      await withAuditDown(async () => {
        expect((await admin.post(`/api/v1/alerts/${target.id}/ack`)).status).toBe(500);
      });
      expect((await alertsAs(admin)).find((a) => a.id === target.id)?.status).toBe('OPEN');
    });

    it('incident: 500 and no synthetic alert remains', async () => {
      const quiet = (await alertsAs(admin)).filter(
        (a) => a.ruleId === 'REFRESH_FAILED' && a.status !== 'RESOLVED',
      );
      const { id } = (
        await t.sql<{ id: string }>(
          `SELECT report_id AS id FROM REPORTS
           WHERE report_id NOT IN (${quiet.map((a) => `'${a.reportId}'`).join(',') || "''"})
           ORDER BY report_id LIMIT 1`,
        )
      )[0]!;
      await withAuditDown(async () => {
        const res = await admin
          .post('/api/v1/admin/incidents')
          .send({ reportId: id, kind: 'REFRESH_FAILED' });
        expect(res.status).toBe(500);
      });
      const after = (await alertsAs(admin)).filter(
        (a) => a.reportId === id && a.ruleId === 'REFRESH_FAILED' && a.status !== 'RESOLVED',
      );
      expect(after).toEqual([]);
    });

    it('replay: 500 and the clock is unchanged', async () => {
      const before = (await admin.get('/api/v1/admin/replay')).body;
      await withAuditDown(async () => {
        expect((await admin.post('/api/v1/admin/replay').send({ action: 'pause' })).status).toBe(
          500,
        );
      });
      expect((await admin.get('/api/v1/admin/replay')).body).toEqual(before);
    });

    it('override: if the alert owner refresh fails after commit, 200 and the next read retries it', async () => {
      const target = (await alertsAs(admin)).find((a) => a.ownerEmail !== null)!;
      const original = t.deps.alerts.refreshOwners.bind(t.deps.alerts);
      let failures = 0;
      t.deps.alerts.refreshOwners = async (db) => {
        if (failures++ === 0) throw new Error('simulated refresh failure');
        return original(db);
      };
      try {
        const res = await admin
          .patch(`/api/v1/reports/${target.reportId}/owner`)
          .send({ ownerEmail: 'retry.owner@company.com' });
        expect(res.status).toBe(200);
        const seen = (await alertsAs(admin)).find((a) => a.id === target.id);
        expect(seen?.ownerEmail).toBe('retry.owner@company.com');
        expect(failures).toBe(2); // failed once in PATCH, succeeded on the next read
      } finally {
        t.deps.alerts.refreshOwners = original;
      }
    });
  });

  describe('incident limits (security review L4)', () => {
    it('repeating an identical incident at the same tick is a no-op (still audited)', async () => {
      const body = { reportId: 'RPT_250', kind: 'LATENCY_SPIKE' };
      const first = await admin.post('/api/v1/admin/incidents').send(body);
      const again = await admin.post('/api/v1/admin/incidents').send(body);
      expect(again.status).toBe(201);
      expect(again.body.id).toBe(first.body.id);
      const audit = await auditRows('INCIDENT_INJECT');
      expect(audit.slice(-2).map((r) => JSON.parse(r.details).duplicate)).toEqual([false, true]);
    });
  });

  describe('replay controls (admin)', () => {
    const state = async (): Promise<ReplayState> => (await admin.get('/api/v1/admin/replay')).body;
    const command = (body: object) => admin.post('/api/v1/admin/replay').send(body);

    it('GET shows the position; only admins', async () => {
      expect(await state()).toEqual({
        tick: LATEST_TICK,
        cycle: 1000,
        snapshotDate: '2026-10-10',
        paused: false,
        speed: 1,
        speeds: [...config.REPLAY_SPEEDS],
        tickMs: config.TICK_MS,
      });
      expect((await owner.get('/api/v1/admin/replay')).status).toBe(403);
      expect((await viewer.post('/api/v1/admin/replay').send({ action: 'pause' })).status).toBe(
        403,
      );
    });

    it('pause freezes the tick; resume continues; wrapping to snapshot 0 starts a new cycle of alerts', async () => {
      expect((await command({ action: 'pause' })).body).toMatchObject({
        paused: true,
        tick: LATEST_TICK,
      });
      t.clock.advance(5 * config.TICK_MS);
      expect((await state()).tick).toBe(LATEST_TICK);
      expect((await request(t.app).get('/health')).body.tick).toBe(LATEST_TICK);

      expect((await command({ action: 'resume' })).body).toMatchObject({
        paused: false,
        tick: LATEST_TICK,
      });
      t.clock.advance(config.TICK_MS);
      expect(await state()).toMatchObject({ tick: 0, cycle: 1001 });
      const alerts = await alertsAs(admin);
      expect(alerts.every((a) => a.id.startsWith('1001-'))).toBe(true);
      // Known limitation: acks and incidents from the previous cycle are gone.
      expect(alerts.some((a) => a.status === 'ACKNOWLEDGED' || a.synthetic)).toBe(false);
    });

    it('speed only accepts the configured multipliers; every command is audit-logged', async () => {
      expect((await command({ action: 'speed', value: 5 })).body).toMatchObject({
        speed: 5,
        tick: 0,
      });
      t.clock.advance(config.TICK_MS / 5);
      expect((await state()).tick).toBe(1);
      const bad = await command({ action: 'speed', value: 3 });
      expect(bad.status).toBe(400);
      expect(bad.body.error.message).toMatch(/^body\.value: must be one of 1, 2, 5, 10/);
      expect((await command({ action: 'rewind' })).status).toBe(400);
      await command({ action: 'speed', value: 1 });

      const audit = await auditRows('REPLAY_CONTROL');
      expect(audit.map((r) => JSON.parse(r.details).command)).toEqual([
        { action: 'pause' },
        { action: 'resume' },
        { action: 'speed', value: 5 },
        { action: 'speed', value: 1 },
      ]);
    });
  });
});
