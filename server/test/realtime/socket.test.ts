import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import {
  ALERTS_NAMESPACE,
  type Alert,
  type AlertAckResponse,
  type ClientToServerEvents,
  type OverviewKpis,
  type Role,
  type ServerToClientEvents,
  type TickEvent,
} from '@pic/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signToken } from '../../src/auth/jwt.js';
import { config } from '../../src/config.js';
import { RealtimeHub } from '../../src/realtime/hub.js';
import { attachAlertsSocket, readCookie, type AlertsServer } from '../../src/realtime/socket.js';
import { createServer } from '../../src/server.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { DEMO_USERS, bearerFor } from '../helpers/auth.js';

type Client = ClientSocket<ServerToClientEvents, ClientToServerEvents>;
interface Recorded {
  socket: Client;
  /** Every server → client event received, in order. */
  events: [string, unknown][];
}

const OWNER = DEMO_USERS.owner.email;
const START_TICK = 10;

let t: TestApp;
let server: http.Server;
let io: AlertsServer;
let base: string;
const open: Client[] = [];

function listen(s: http.Server): Promise<string> {
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`),
    );
  });
}

function tokenFor(role: Role, expiresInSec?: number): string {
  return signToken({ email: DEMO_USERS[role].email, role }, expiresInSec).token;
}

/** A socket to /alerts on `url` with the given handshake headers. Not yet connected. */
function socketTo(
  url: string,
  headers: Record<string, string>,
  auth?: object,
  transport: 'websocket' | 'polling' = 'websocket',
): Client {
  const socket: Client = ioClient(`${url}${ALERTS_NAMESPACE}`, {
    transports: [transport],
    extraHeaders: headers,
    reconnection: false,
    forceNew: true,
    auth,
  });
  open.push(socket);
  return socket;
}

const cookie = (token: string) => ({ cookie: `${config.AUTH_COOKIE}=${token}` });

function connectError(socket: Client): Promise<{ message: string; data?: { code?: string } }> {
  return new Promise((resolve, reject) => {
    socket.once('connect_error', (err) => resolve(err as never));
    socket.once('connect', () => reject(new Error('expected the handshake to be rejected')));
  });
}

/** Connected as `role`, after its initial tick, snapshot and KPIs arrived. */
async function connectAs(role: Role, token = tokenFor(role)): Promise<Recorded> {
  const socket = socketTo(base, cookie(token));
  const events: [string, unknown][] = [];
  socket.onAny((event: string, payload: unknown) => events.push([event, payload]));
  await vi.waitFor(() => expect(events.map(([e]) => e)).toContain('kpi:update'), {
    timeout: 5000,
  });
  return { socket, events };
}

const payloads = <T>(r: Recorded, event: string): T[] =>
  r.events.filter(([e]) => e === event).map(([, p]) => p as T);
const lastSnapshot = (r: Recorded) => payloads<Alert[]>(r, 'alert:snapshot').at(-1) ?? [];
const alertEvents = (r: Recorded) => [
  ...payloads<Alert>(r, 'alert:opened'),
  ...payloads<Alert>(r, 'alert:updated'),
  ...payloads<Alert[]>(r, 'alert:snapshot').flat(),
];

const api = () => request(t.app);
const activeIds = (alerts: Alert[]) => alerts.map((a) => a.id).sort();

let admin: Recorded;
let owner: Recorded;
let viewer: Recorded;

beforeAll(async () => {
  t = await buildTestApp();
  t.clock.set(START_TICK);
  ({ server, io } = createServer(t.deps, { loginRateLimit: false }));
  base = await listen(server);
  await t.deps.realtime.sync();
  [admin, owner, viewer] = await Promise.all([
    connectAs('admin'),
    connectAs('owner'),
    connectAs('viewer'),
  ]);
});

afterAll(async () => {
  for (const s of open) s.disconnect();
  await new Promise((resolve) => io.close(resolve));
  t?.close();
});

describe('handshake authentication', () => {
  it.each([
    ['no cookie', {}],
    ['a garbage token', cookie('not-a-jwt')],
    [
      'a token whose role does not match the account',
      cookie(signToken({ email: OWNER, role: 'admin' }).token),
    ],
    ['an expired token', cookie(tokenFor('admin', -10))],
    ['an unknown cookie name', { cookie: `other=${tokenFor('admin')}` }],
  ])('rejects %s with UNAUTHENTICATED', async (_label, headers) => {
    const err = await connectError(socketTo(base, headers));
    expect(err.message).toBe('UNAUTHENTICATED');
    expect(err.data?.code).toBe('UNAUTHENTICATED');
  });

  it('ignores a token in `auth` (the cookie is the only credential)', async () => {
    const err = await connectError(socketTo(base, {}, { token: tokenFor('admin') }));
    expect(err.message).toBe('UNAUTHENTICATED');
  });

  it('serves nothing on the default namespace', async () => {
    const socket = ioClient(base, {
      transports: ['websocket'],
      extraHeaders: cookie(tokenFor('admin')),
      reconnection: false,
      forceNew: true,
    });
    open.push(socket as Client);
    const err = await connectError(socket as Client);
    expect(err.message).toBe('NOT_FOUND');
  });

  it('with enforceOrigin (production): Origin must match Host (or Sec-Fetch-Site: same-origin)', async () => {
    // A second transport on its own hub, so the main hub's namespace is untouched.
    const http2 = (await import('node:http')).createServer();
    const io2 = attachAlertsSocket(
      http2,
      new RealtimeHub(t.warehouse, t.deps.clock, t.deps.alerts),
      { enforceOrigin: true },
    );
    const url = await listen(http2);
    try {
      const token = cookie(tokenFor('admin'));
      expect((await connectError(socketTo(url, token))).message).toBe('BAD_ORIGIN');
      expect(
        (await connectError(socketTo(url, { ...token, origin: 'http://evil.example' }))).message,
      ).toBe('BAD_ORIGIN');
      const connects = async (socket: Client) => {
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('connect_error', reject);
        });
        socket.disconnect();
      };
      await connects(socketTo(url, { ...token, origin: url }));

      // Polling opens with a same-origin GET, on which browsers send no Origin, only
      // Sec-Fetch-Site. A same-origin one is accepted; cross-site or neither is not.
      const polling = (headers: Record<string, string>) =>
        socketTo(url, { ...token, ...headers }, undefined, 'polling');
      await connects(polling({ 'sec-fetch-site': 'same-origin' }));
      expect((await connectError(polling({}))).message).toBe('BAD_ORIGIN');
      expect((await connectError(polling({ 'sec-fetch-site': 'cross-site' }))).message).toBe(
        'BAD_ORIGIN',
      );
      expect(
        (
          await connectError(
            polling({ origin: 'http://evil.example', 'sec-fetch-site': 'same-origin' }),
          )
        ).message,
      ).toBe('BAD_ORIGIN');
    } finally {
      await new Promise((resolve) => io2.close(resolve));
    }
  });

  it('disconnects the socket when its session expires', async () => {
    const short = await connectAs('viewer', tokenFor('viewer', 2));
    const reason = await new Promise<string>((resolve) => short.socket.once('disconnect', resolve));
    expect(reason).toBe('io server disconnect');
  }, 6000);

  it('readCookie picks one cookie out of a header', () => {
    expect(readCookie('a=1; pic_token=abc.def; b=2', 'pic_token')).toBe('abc.def');
    expect(readCookie('pic_tokenx=1', 'pic_token')).toBeUndefined();
    expect(readCookie(undefined, 'pic_token')).toBeUndefined();
    expect(readCookie('pic_token=%E0%A4%A', 'pic_token')).toBeUndefined();
  });
});

describe('initial state on connect', () => {
  it('sends tick, alert:snapshot and kpi:update, in that order', () => {
    for (const r of [admin, owner, viewer]) {
      expect(r.events.slice(0, 3).map(([e]) => e)).toEqual([
        'tick',
        'alert:snapshot',
        'kpi:update',
      ]);
      expect(payloads<TickEvent>(r, 'tick')[0]).toMatchObject({ tick: START_TICK, paused: false });
    }
  });

  it('admins and viewers get every active alert; owners only alerts on their reports', () => {
    const all = t.deps.alerts.list({ kind: 'all' }).filter((a) => a.status !== 'RESOLVED');
    expect(activeIds(lastSnapshot(admin))).toEqual(activeIds(all));
    expect(lastSnapshot(viewer)).toEqual(lastSnapshot(admin));
    const mine = lastSnapshot(owner);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((a) => a.ownerEmail === OWNER)).toBe(true);
    expect(activeIds(mine)).toEqual(activeIds(all.filter((a) => a.ownerEmail === OWNER)));
  });

  it('kpi:update equals GET /overview for the same role', async () => {
    for (const [r, role] of [
      [admin, 'admin'],
      [owner, 'owner'],
      [viewer, 'viewer'],
    ] as const) {
      const res = await api().get('/api/v1/overview').set('Authorization', bearerFor(role));
      expect(payloads<OverviewKpis>(r, 'kpi:update')[0]).toEqual(res.body);
    }
  });
});

describe('broadcasts are scoped by room', () => {
  /** A report in `pick` with no active alert for `ruleId`, so an incident opens a new alert. */
  function quietReport(pick: (ownerEmail: string | null) => boolean) {
    const active = t.deps.alerts.list({ kind: 'all' }).filter((a) => a.status !== 'RESOLVED');
    return async () => {
      const res = await api()
        .get('/api/v1/reports?pageSize=100')
        .set('Authorization', bearerFor('admin'));
      for (const r of res.body.items as { reportId: string; currentOwner: string | null }[]) {
        if (!pick(r.currentOwner)) continue;
        for (const [kind, ruleId] of [
          ['LATENCY_SPIKE', 'LATENCY'],
          ['REFRESH_FAILED', 'REFRESH_FAILED'],
        ] as const) {
          if (!active.some((a) => a.reportId === r.reportId && a.ruleId === ruleId)) {
            return { reportId: r.reportId, kind, ownerEmail: r.currentOwner };
          }
        }
      }
      throw new Error('no quiet report found');
    };
  }

  let mineId: string;
  let otherId: string;
  let otherReport: { reportId: string; ownerEmail: string | null };

  it('an injected incident reaches admin and viewer; the owner only for their own report', async () => {
    const mine = await quietReport((o) => o === OWNER)();
    const other = await quietReport((o) => o !== null && o !== OWNER)();
    otherReport = other;
    const inject = (r: { reportId: string; kind: string }) =>
      api()
        .post('/api/v1/admin/incidents')
        .set('Authorization', bearerFor('admin'))
        .send({ reportId: r.reportId, kind: r.kind })
        .expect(201);
    mineId = (await inject(mine)).body.id;
    otherId = (await inject(other)).body.id;

    const openedIds = (r: Recorded) => payloads<Alert>(r, 'alert:opened').map((a) => a.id);
    await vi.waitFor(() => {
      expect(openedIds(admin)).toEqual(expect.arrayContaining([mineId, otherId]));
      expect(openedIds(viewer)).toEqual(expect.arrayContaining([mineId, otherId]));
      expect(openedIds(owner)).toContain(mineId);
    });
    expect(openedIds(owner)).not.toContain(otherId);
    expect(payloads<Alert>(admin, 'alert:opened').find((a) => a.id === mineId)).toMatchObject({
      synthetic: true,
      ownerEmail: OWNER,
    });
  });

  it('a tick: everyone gets one tick and one kpi:update for the new snapshot, scoped', async () => {
    const kpiCount = (r: Recorded) => payloads(r, 'kpi:update').length;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
    await settle(); // let KPI passes from earlier tests finish
    const kpisBefore = [admin, owner, viewer].map(kpiCount);
    t.clock.advance(config.TICK_MS);
    await t.deps.realtime.sync();
    const next = START_TICK + 1;
    for (const r of [admin, owner, viewer]) {
      await vi.waitFor(() => {
        expect(payloads<TickEvent>(r, 'tick').at(-1)?.tick).toBe(next);
        expect(payloads<OverviewKpis>(r, 'kpi:update').at(-1)?.tick).toBe(next);
      });
    }
    await settle();
    // The tick and the alert events of one sync share a single KPI pass.
    expect([admin, owner, viewer].map(kpiCount)).toEqual(kpisBefore.map((n) => n + 1));
    const ownerOverview = await api()
      .get('/api/v1/overview')
      .set('Authorization', bearerFor('owner'));
    expect(payloads<OverviewKpis>(owner, 'kpi:update').at(-1)).toEqual(ownerOverview.body);
    expect(payloads<OverviewKpis>(admin, 'kpi:update').at(-1)?.reportCount).toBeGreaterThan(
      ownerOverview.body.reportCount,
    );
  });

  it('alert:ack over the socket: role, scope and payload checks', async () => {
    const ack = (r: Recorded, payload: unknown) =>
      r.socket.timeout(3000).emitWithAck('alert:ack', payload as { alertId: string });

    expect(await ack(viewer, { alertId: mineId })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    // Another owner's alert is NOT_FOUND for the owner (no existence leak).
    expect(await ack(owner, { alertId: otherId })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(await ack(owner, { nope: 1 })).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
    expect(await ack(owner, 'just a string')).toMatchObject({ error: { code: 'BAD_REQUEST' } });

    const res: AlertAckResponse = await ack(owner, { alertId: mineId });
    expect(res).toMatchObject({
      ok: true,
      alert: { id: mineId, status: 'ACKNOWLEDGED', ackedBy: OWNER },
    });
    const updated = (r: Recorded) =>
      payloads<Alert>(r, 'alert:updated').some(
        (a) => a.id === mineId && a.status === 'ACKNOWLEDGED',
      );
    await vi.waitFor(() => {
      expect(updated(admin)).toBe(true);
      expect(updated(viewer)).toBe(true);
      expect(updated(owner)).toBe(true);
    });
    const audit = await t.sql<{ n: number }>(
      `SELECT COUNT(*)::INTEGER AS n FROM AUDIT_LOG WHERE action = 'ALERT_ACK' AND target = '${mineId}'`,
    );
    expect(audit[0]!.n).toBe(1);

    // A repeat is idempotent: ok, but no second audit row and no event.
    expect(await ack(owner, { alertId: mineId })).toMatchObject({ ok: true });
  });

  it('an ack without a callback does not break the connection', async () => {
    // The typed client always requires a callback; send the raw event without one.
    (owner.socket as unknown as { emit(event: string, payload: unknown): void }).emit('alert:ack', {
      alertId: mineId,
    });
    expect(
      await owner.socket.timeout(3000).emitWithAck('alert:ack', { alertId: 'missing' }),
    ).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('a REST ack is broadcast too, only to the rooms that can see the alert', async () => {
    await api()
      .post(`/api/v1/alerts/${encodeURIComponent(otherId)}/ack`)
      .set('Authorization', bearerFor('admin'))
      .expect(200);
    const acked = (r: Recorded) =>
      payloads<Alert>(r, 'alert:updated').some(
        (a) => a.id === otherId && a.status === 'ACKNOWLEDGED',
      );
    await vi.waitFor(() => {
      expect(acked(admin)).toBe(true);
      expect(acked(viewer)).toBe(true);
    });
    expect(payloads<Alert>(owner, 'alert:updated').some((a) => a.id === otherId)).toBe(false);
  });

  it('a bulk ack broadcasts one alert:updated per changed alert, scoped like single acks', async () => {
    const openNow = lastSnapshot(admin).filter((a) => a.status === 'OPEN');
    const mine = openNow.find((a) => a.ownerEmail === OWNER && a.id !== mineId);
    const theirs = openNow.find((a) => a.ownerEmail !== OWNER && a.id !== otherId);
    if (!mine || !theirs) throw new Error('fixture: need an OPEN alert for the owner and another');

    const res = await api()
      .post('/api/v1/alerts/ack')
      .set('Authorization', bearerFor('admin'))
      .send({ alertIds: [mine.id, theirs.id] })
      .expect(200);
    expect(res.body.newlyAcknowledged).toBe(2);

    const acked = (r: Recorded, id: string) =>
      payloads<Alert>(r, 'alert:updated').filter((a) => a.id === id && a.status === 'ACKNOWLEDGED');
    await vi.waitFor(() => {
      for (const id of [mine.id, theirs.id]) {
        expect(acked(admin, id)).toHaveLength(1);
        expect(acked(viewer, id)).toHaveLength(1);
      }
      expect(acked(owner, mine.id)).toHaveLength(1);
    });
    expect(acked(owner, theirs.id)).toHaveLength(0); // not their alert: they never hear of it
  });

  it('reassigning a report re-sends scoped snapshots: its alerts move to the new owner', async () => {
    const before = payloads(owner, 'alert:snapshot').length;
    await api()
      .patch(`/api/v1/reports/${otherReport.reportId}/owner`)
      .set('Authorization', bearerFor('admin'))
      .send({ ownerEmail: OWNER })
      .expect(200);
    await vi.waitFor(() => expect(payloads(owner, 'alert:snapshot').length).toBe(before + 1));
    expect(lastSnapshot(owner).map((a) => a.id)).toContain(otherId);
    expect(lastSnapshot(admin).find((a) => a.id === otherId)?.ownerEmail).toBe(OWNER);

    await api()
      .patch(`/api/v1/reports/${otherReport.reportId}/owner`)
      .set('Authorization', bearerFor('admin'))
      .send({ ownerEmail: otherReport.ownerEmail })
      .expect(200);
    await vi.waitFor(() => expect(payloads(owner, 'alert:snapshot').length).toBe(before + 2));
    expect(lastSnapshot(owner).map((a) => a.id)).not.toContain(otherId);
  });

  it('a new replay cycle replaces the list with a snapshot instead of N alert:opened', async () => {
    const opened = payloads(admin, 'alert:opened').length;
    const snapshots = payloads(admin, 'alert:snapshot').length;
    t.clock.advance((config.SNAPSHOT_COUNT - START_TICK) * config.TICK_MS); // → tick 1, next cycle
    await t.deps.realtime.sync();
    await vi.waitFor(() => expect(payloads(admin, 'alert:snapshot').length).toBe(snapshots + 1));
    expect(payloads(admin, 'alert:opened').length).toBe(opened);
    expect(payloads<TickEvent>(admin, 'tick').at(-1)?.tick).toBe(1);
  });

  it('across this whole file, the owner never received an alert outside their scope', () => {
    const seen = alertEvents(owner);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((a) => a.ownerEmail !== OWNER)).toEqual([]);
  });
});
