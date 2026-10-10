/**
 * WebSocket scoping smoke test (docs/WEBSOCKET.md).
 *
 *   npm run ws-smoke -- [baseUrl] [--seconds 30] [--inject]
 *
 * Signs in as each demo role (admin, owner user_3, viewer), connects to the /alerts namespace with
 * the session cookie, prints every event it receives, and after `--seconds` checks the scoping:
 *   - every alert the owner received is on a report they own;
 *   - the owner saw no alert the admin didn't; the viewer saw the same alerts as the admin.
 * With --inject, the admin also injects a LATENCY_SPIKE on one report the owner owns and one they
 * don't (this writes audit rows), and the script checks who heard about each.
 * Exits 1 on any violation. baseUrl defaults to $SMOKE_URL, then http://localhost:3000.
 */
import { parseArgs } from 'node:util';
import { io, type Socket } from 'socket.io-client';
import {
  ALERTS_NAMESPACE,
  type Alert,
  type ClientToServerEvents,
  type OverviewKpis,
  type Role,
  type ServerToClientEvents,
  type TickEvent,
} from '@pic/shared';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seconds: { type: 'string', default: '30' },
    inject: { type: 'boolean', default: false },
  },
});
const BASE = (positionals[0] ?? process.env.SMOKE_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);
const SECONDS = Number(values.seconds);
if (!(SECONDS > 0)) throw new Error(`--seconds must be a positive number, got ${values.seconds}`);

/** The public demo credentials (README). */
const USERS: { role: Role; email: string; password: string }[] = [
  { role: 'admin', email: 'admin@pureinsights.dev', password: 'Admin@123' },
  { role: 'owner', email: 'user_3@company.com', password: 'Owner@123' },
  { role: 'viewer', email: 'viewer@pureinsights.dev', password: 'Viewer@123' },
];
const OWNER_EMAIL = USERS[1]!.email;

interface Session {
  role: Role;
  cookie: string;
  socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  counts: Map<string, number>;
  /** Every alert id this session heard about (snapshots and events). */
  alertIds: Set<string>;
  alerts: Alert[];
  connected: boolean;
}

const started = Date.now();
const stamp = () => `+${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`;
const log = (role: string, text: string) => console.log(`${stamp()} [${role.padEnd(6)}] ${text}`);

async function login(user: (typeof USERS)[number]): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    // Production rejects cookie-less POSTs only without Origin when a cookie is present; sending
    // the Origin keeps this valid against a production build too.
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  if (!res.ok) throw new Error(`login as ${user.role} failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .find((c) => c.startsWith('pic_token='));
  if (!cookie) throw new Error(`login as ${user.role}: no pic_token cookie in the response`);
  return cookie;
}

const describeAlert = (a: Alert) =>
  `${a.reportId} ${a.ruleId} ${a.severity} ${a.status} owner=${a.ownerEmail ?? '(orphaned)'}` +
  (a.synthetic ? ' synthetic' : '');

function open(role: Role, cookie: string): Session {
  const socket: Session['socket'] = io(`${BASE}${ALERTS_NAMESPACE}`, {
    extraHeaders: { cookie, origin: BASE },
  });
  const s: Session = {
    role,
    cookie,
    socket,
    counts: new Map(),
    alertIds: new Set(),
    alerts: [],
    connected: false,
  };
  const count = (event: string) => s.counts.set(event, (s.counts.get(event) ?? 0) + 1);
  const seen = (a: Alert) => {
    s.alertIds.add(a.id);
    s.alerts.push(a);
  };

  socket.on('connect', () => {
    s.connected = true;
    log(role, `connected (${socket.id})`);
  });
  socket.on('connect_error', (err) => log(role, `connect_error: ${err.message}`));
  socket.on('disconnect', (reason) => log(role, `disconnected: ${reason}`));
  socket.on('tick', (e: TickEvent) => {
    count('tick');
    log(role, `tick ${e.tick} (${e.snapshotDate})${e.paused ? ' paused' : ''}`);
  });
  socket.on('alert:snapshot', (alerts: Alert[]) => {
    count('alert:snapshot');
    alerts.forEach(seen);
    const owners = [...new Set(alerts.map((a) => a.ownerEmail ?? '(orphaned)'))];
    log(role, `alert:snapshot ${alerts.length} active; owners: ${owners.length} distinct`);
  });
  for (const event of ['alert:opened', 'alert:updated'] as const) {
    socket.on(event, (a: Alert) => {
      count(event);
      seen(a);
      log(role, `${event} ${describeAlert(a)}`);
    });
  }
  socket.on('kpi:update', (k: OverviewKpis) => {
    count('kpi:update');
    log(role, `kpi:update tick ${k.tick} reports=${k.reportCount} active alerts=${k.alerts.total}`);
  });
  return s;
}

async function api<T>(session: Session, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { cookie: session.cookie, origin: BASE, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** As admin: a LATENCY_SPIKE on one report the owner owns and one owned by someone else. */
async function inject(admin: Session): Promise<{ mine: Alert; other: Alert }> {
  const page = await api<{ items: { reportId: string; currentOwner: string | null }[] }>(
    admin,
    'GET',
    '/reports?pageSize=100',
  );
  const mine = page.items.find((r) => r.currentOwner === OWNER_EMAIL);
  const other = page.items.find((r) => r.currentOwner !== null && r.currentOwner !== OWNER_EMAIL);
  if (!mine || !other) throw new Error('could not find an owned and a non-owned report');
  const spike = (reportId: string) =>
    api<Alert>(admin, 'POST', '/admin/incidents', { reportId, kind: 'LATENCY_SPIKE' });
  const result = { mine: await spike(mine.reportId), other: await spike(other.reportId) };
  log('admin', `injected ${describeAlert(result.mine)}`);
  log('admin', `injected ${describeAlert(result.other)}`);
  return result;
}

async function main(): Promise<number> {
  console.log(`ws-smoke against ${BASE} for ${SECONDS}s${values.inject ? ' (with --inject)' : ''}`);
  console.log('(a sleeping Render instance can take ~50s to wake on the first request)');
  const sessions = await Promise.all(USERS.map(async (u) => open(u.role, await login(u))));
  const [admin, owner, viewer] = sessions as [Session, Session, Session];

  let injected: { mine: Alert; other: Alert } | null = null;
  if (values.inject) {
    // Let every socket receive its initial snapshot first, so all three hear the incidents.
    await new Promise((r) => setTimeout(r, 2000));
    injected = await inject(admin);
  }
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  for (const s of sessions) s.socket.disconnect();

  const problems: string[] = [];
  const check = (ok: boolean, what: string) => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
    if (!ok) problems.push(what);
  };

  console.log('\nEvents received:');
  for (const s of sessions) {
    const counts = [...s.counts].map(([e, n]) => `${e}×${n}`).join('  ') || '(none)';
    console.log(`  ${s.role.padEnd(6)} ${counts}`);
  }
  console.log('\nScoping:');
  for (const s of sessions) check(s.connected, `${s.role} connected`);
  const strays = owner.alerts.filter((a) => a.ownerEmail !== OWNER_EMAIL);
  check(
    strays.length === 0,
    `owner received only alerts on their reports (${owner.alerts.length} alert payloads, ${strays.length} outside scope)`,
  );
  const notForAdmin = [...owner.alertIds].filter((id) => !admin.alertIds.has(id));
  check(notForAdmin.length === 0, `owner's alerts ⊆ admin's (${notForAdmin.length} extra)`);
  const sameAsAdmin =
    viewer.alertIds.size === admin.alertIds.size &&
    [...viewer.alertIds].every((id) => admin.alertIds.has(id));
  check(
    sameAsAdmin,
    `viewer saw the same alerts as admin (${viewer.alertIds.size} vs ${admin.alertIds.size})`,
  );
  if (injected) {
    const { mine, other } = injected;
    check(
      admin.alertIds.has(mine.id) && admin.alertIds.has(other.id),
      'admin heard both incidents',
    );
    check(
      viewer.alertIds.has(mine.id) && viewer.alertIds.has(other.id),
      'viewer heard both incidents',
    );
    check(owner.alertIds.has(mine.id), 'owner heard the incident on their report');
    check(
      !owner.alertIds.has(other.id),
      "owner did not hear the incident on another owner's report",
    );
  }
  console.log(
    problems.length === 0
      ? '\nAll scoping checks passed.'
      : `\n${problems.length} check(s) failed.`,
  );
  return problems.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
