import type { AuditLogEntry, ChargebackRow, ReportDetail } from '@pic/shared';
import request, { type Agent } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { loginAs } from '../helpers/auth.js';

const OWNER = 'user_3@company.com';

/**
 * PATCH /reports/:id/owner. Tests run in order and build on each other: the warehouse is
 * shared, so each step states the overrides in effect.
 */
describe('owner override (admin) and audit log', () => {
  let t: TestApp;
  let admin: Agent;
  let owner: Agent;
  let viewer: Agent;
  let orphan: string; // orphaned at ingest; given to user_3
  let ownedByUser3: string; // user_3's at ingest; orphaned later

  const one = async <T>(sql: string) => (await t.sql<T>(sql))[0]!;
  const auditCount = async () =>
    (await one<{ n: number }>('SELECT count(*)::INTEGER AS n FROM AUDIT_LOG')).n;
  const chargeback = async (view: 'current' | 'point_in_time', who: string) => {
    const res = await admin.get(`/api/v1/costs/chargeback?view=${view}&pageSize=100`);
    return (res.body.items as ChargebackRow[]).find((r) => r.owner === who);
  };
  const patch = (agent: Agent, id: string, body: object) =>
    agent.patch(`/api/v1/reports/${id}/owner`).send(body);

  beforeAll(async () => {
    t = await buildTestApp();
    [admin, owner, viewer] = await Promise.all([
      loginAs(t.app, 'admin'),
      loginAs(t.app, 'owner'),
      loginAs(t.app, 'viewer'),
    ]);
    orphan = (
      await one<{ id: string }>(
        'SELECT report_id AS id FROM REPORTS WHERE current_owner IS NULL ORDER BY report_id LIMIT 1',
      )
    ).id;
    ownedByUser3 = (
      await one<{ id: string }>(
        `SELECT report_id AS id FROM REPORTS WHERE current_owner = '${OWNER}' ORDER BY report_id LIMIT 1`,
      )
    ).id;
  }, 60_000);
  afterAll(() => t.close());

  it('only admins: 401 anonymous, 403 owner and viewer; nothing written', async () => {
    const body = { ownerEmail: OWNER };
    expect((await request(t.app).patch(`/api/v1/reports/${orphan}/owner`).send(body)).status).toBe(
      401,
    );
    for (const agent of [owner, viewer]) {
      const res = await patch(agent, orphan, body);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    expect(await auditCount()).toBe(0);
  });

  it('validates the body and the id; 404 for an unknown report; nothing written', async () => {
    const cases: [string, object, number, RegExp][] = [
      [orphan, { ownerEmail: 'not-an-email' }, 400, /^body\.ownerEmail/],
      [orphan, {}, 400, /^body\.ownerEmail/],
      [orphan, { ownerEmail: OWNER, reason: 'x'.repeat(501) }, 400, /^body\.reason/],
      ['bad-id', { ownerEmail: OWNER }, 400, /^params\.id/],
      ['RPT_999', { ownerEmail: OWNER }, 404, /RPT_999 not found/],
    ];
    for (const [id, body, status, message] of cases) {
      const res = await patch(admin, id, body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(res.body.error.message).toMatch(message);
    }
    expect(await auditCount()).toBe(0);
  });

  it('assigns an orphaned report: one OWNER_OVERRIDES row, one AUDIT_LOG row', async () => {
    const pitBefore = await chargeback('point_in_time', OWNER);
    const res = await patch(admin, orphan, {
      ownerEmail: '  User_3@Company.com ',
      reason: 'Reorg',
    });
    expect(res.status).toBe(200);
    const d: ReportDetail = res.body;
    expect(d).toMatchObject({
      reportId: orphan,
      snapshotOwner: null, // the snapshot's own owner is unchanged; the override is separate
      currentOwner: OWNER,
      isOrphaned: false,
      isOverridden: true,
    });
    expect(d.override).toMatchObject({
      ownerEmail: OWNER,
      setBy: 'admin@pureinsights.dev',
      reason: 'Reorg',
    });
    expect(Date.now() - Date.parse(d.override!.setAt)).toBeLessThan(60_000); // UTC, not local time

    expect(await t.sql(`SELECT report_id, owner_email FROM OWNER_OVERRIDES`)).toEqual([
      { report_id: orphan, owner_email: OWNER },
    ]);
    const audit = await t.sql<{
      actor_email: string;
      action: string;
      target: string;
      details: string;
    }>('SELECT actor_email, action, target, details FROM AUDIT_LOG');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_email: 'admin@pureinsights.dev',
      action: 'OWNER_OVERRIDE',
      target: orphan,
    });
    expect(JSON.parse(audit[0]!.details)).toEqual({
      before: null,
      after: OWNER,
      replacedOverride: false,
      reason: 'Reorg',
    });

    // Point-in-time chargeback is about past snapshot owners, so it doesn't move.
    expect(await chargeback('point_in_time', OWNER)).toEqual(pitBefore);
  });

  it('the new owner sees it everywhere; current-owner views follow; C1–C5 still PASS', async () => {
    const list = await owner.get('/api/v1/reports?pageSize=100');
    expect(list.body.total).toBe(12);
    expect((await owner.get(`/api/v1/reports/${orphan}`)).status).toBe(200);
    const costs = await owner.get('/api/v1/costs/reports?pageSize=100');
    expect(costs.body.items.map((r: { reportId: string }) => r.reportId)).toContain(orphan);

    expect((await chargeback('current', OWNER))?.reportCount).toBe(12);
    expect((await chargeback('current', 'UNOWNED'))?.reportCount).toBe(13);
    expect((await admin.get('/api/v1/overview')).body.orphanedCount).toBe(13);
    const zombies = (await admin.get('/api/v1/costs/anomalies')).body.zombies as {
      reportId: string;
      reason: string;
    }[];
    expect(zombies.find((z) => z.reportId === orphan)?.reason ?? 'none').not.toMatch(
      /ORPHANED|BOTH/,
    );

    // Conservation on the live views, with the override in place.
    const recon = await t.sql<{ check_id: string; status: string }>(
      `SELECT check_id, status FROM RECONCILIATION WHERE check_kind = 'CONSERVATION'`,
    );
    expect(recon.map((r) => r.status)).toEqual(['PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
  });

  it('null orphans a report; a second PATCH replaces (not duplicates) the override', async () => {
    const res = await patch(admin, ownedByUser3, { ownerEmail: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      snapshotOwner: OWNER,
      currentOwner: null,
      isOrphaned: true, // the override wins over the snapshot's owner
      isOverridden: true,
    });
    expect((await owner.get('/api/v1/reports')).body.total).toBe(11); // 12 − 1
    expect((await owner.get(`/api/v1/reports/${ownedByUser3}`)).status).toBe(404);

    const again = await patch(admin, ownedByUser3, { ownerEmail: 'new.owner@company.com' });
    expect(again.body.currentOwner).toBe('new.owner@company.com');
    const rows = await t.sql(
      `SELECT owner_email FROM OWNER_OVERRIDES WHERE report_id = '${ownedByUser3}'`,
    );
    expect(rows).toEqual([{ owner_email: 'new.owner@company.com' }]);
    expect((await chargeback('current', 'new.owner@company.com'))?.reportCount).toBe(1);
    expect(await auditCount()).toBe(3);
  });

  it('is atomic: if the audit insert fails, the override is not written either', async () => {
    const before = await t.sql('SELECT * FROM OWNER_OVERRIDES ORDER BY report_id');
    await t.db.conn.run('ALTER TABLE AUDIT_LOG RENAME TO AUDIT_LOG_OFFLINE');
    try {
      const res = await patch(admin, orphan, { ownerEmail: 'someone.else@company.com' });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL');
    } finally {
      await t.db.conn.run('ALTER TABLE AUDIT_LOG_OFFLINE RENAME TO AUDIT_LOG');
    }
    expect(await t.sql('SELECT * FROM OWNER_OVERRIDES ORDER BY report_id')).toEqual(before);
    expect((await owner.get(`/api/v1/reports/${orphan}`)).status).toBe(200); // still user_3's
  });

  describe('GET /admin/audit-log', () => {
    it('admin: newest first, details parsed, filterable by action', async () => {
      const res = await admin.get('/api/v1/admin/audit-log');
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      const items: AuditLogEntry[] = res.body.items;
      expect(items.map((e) => e.target)).toEqual([ownedByUser3, ownedByUser3, orphan]);
      expect(items[0]!.details).toMatchObject({
        before: null,
        after: 'new.owner@company.com',
        replacedOverride: true,
      });
      const times = items.map((e) => Date.parse(e.at));
      expect(times).toEqual([...times].sort((a, b) => b - a));

      const filtered = await admin.get('/api/v1/admin/audit-log?action=ALERT_ACK');
      expect(filtered.body).toEqual({ items: [], page: 1, pageSize: 25, total: 0 });
      expect((await admin.get('/api/v1/admin/audit-log?action=NOPE')).status).toBe(400);
    });

    it('owner and viewer: 403', async () => {
      for (const agent of [owner, viewer]) {
        expect((await agent.get('/api/v1/admin/audit-log')).status).toBe(403);
      }
    });
  });
});
