import {
  Activity,
  BarChart3,
  Bell,
  DatabaseZap,
  DollarSign,
  LayoutDashboard,
  LogOut,
  Menu,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { OverviewScope, Role } from '@pic/shared';
import { useTrend } from '../api/queries';
import { useAuth } from '../auth/AuthProvider';
import { SCOPE_PARAM, parseScope, useOverviewScope } from '../lib/overviewScope';
import { useAlerts, type ConnectionStatus } from '../realtime/AlertsProvider';
import AdminControls from './AdminControls';
import CriticalPopup from './CriticalPopup';
import NotificationBell from './NotificationBell';
import Popover from './Popover';
import { RoleBadge } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Roles that may use the page; omitted = all. Items a role cannot use are hidden. */
  roles?: readonly Role[];
}

const NAV: readonly NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
  { to: '/alerts', label: 'Alerts', icon: Bell },
  { to: '/costs', label: 'Cost Attribution', icon: DollarSign },
  { to: '/data-quality', label: 'Data Quality', icon: DatabaseZap },
];

const STATUS: Record<ConnectionStatus, { label: string; dot: string }> = {
  connected: { label: 'Connected', dot: 'bg-emerald-500' },
  connecting: { label: 'Connecting…', dot: 'bg-gray-400' },
  reconnecting: { label: 'Reconnecting…', dot: 'bg-amber-500 animate-pulse' },
  offline: { label: 'Offline', dot: 'bg-red-500' },
};

/** One pill for connection + replay position: "● Live · Snapshot 7/20". */
function LiveStatus() {
  const { tick, status } = useAlerts();
  const total = useTrend().data?.points.length;
  const { label, dot } = STATUS[status];
  const state = status !== 'connected' ? label : tick?.paused ? 'Paused' : 'Live';
  return (
    <span
      className="flex items-center gap-2 rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700 tabular-nums"
      role="status"
      title={`Live alerts: ${label}${tick ? ` · snapshot date ${tick.snapshotDate}` : ''}`}
    >
      <span className={`size-2 rounded-full ${dot}`} aria-hidden />
      <span className="font-medium">{state}</span>
      {tick && (
        <span className="hidden text-gray-500 sm:inline">
          Snapshot {tick.tick + 1}
          {total ? `/${total}` : ''}
        </span>
      )}
    </span>
  );
}

/**
 * Today / Period-to-date switch. Today = the replay's snapshot N; period = snapshots 1..N.
 * The choice lives in the URL (?scope=) so it can be shared and survives a reload.
 */
function Avatar({ email }: { email: string }) {
  return (
    <span className="flex size-7 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-strong uppercase">
      {email.charAt(0)}
    </span>
  );
}

function ScopeSwitch() {
  const { tick } = useAlerts();
  const { scope, setScope } = useOverviewScope();
  const { pathname } = useLocation();
  const options: { value: OverviewScope; short: string; long: string }[] = [
    { value: 'today', short: 'Today', long: `Today · ${tick?.snapshotDate ?? '—'}` },
    {
      value: 'period',
      short: 'Period',
      long: `Period to date (1–${tick ? tick.tick + 1 : '—'})`,
    },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Time range"
      className="inline-flex rounded-xl bg-gray-100 p-1 text-sm ring-1 ring-gray-200"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={scope === o.value}
          title={
            o.long + (o.value === 'period' && pathname !== '/' ? ' (applies to Overview)' : '')
          }
          onClick={() => setScope(o.value)}
          className={`rounded-lg px-5 py-2 font-semibold whitespace-nowrap transition-colors ${
            scope === o.value
              ? 'bg-accent text-white shadow-md shadow-accent/30'
              : 'text-gray-600 hover:bg-white hover:text-gray-900'
          }`}
        >
          {o.short}
        </button>
      ))}
    </div>
  );
}

/**
 * Keeps ?scope= on every URL: a link or filter reset that drops it gets the last value back,
 * so the switch survives navigation. Replaces the history entry (no extra Back step).
 */
function useKeepScopeInUrl() {
  const location = useLocation();
  const navigate = useNavigate();
  const last = useRef<OverviewScope>('today');
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const current = parseScope(params.get(SCOPE_PARAM));
    if (current) {
      last.current = current;
      return;
    }
    params.set(SCOPE_PARAM, last.current);
    void navigate(
      { pathname: location.pathname, search: `?${params.toString()}`, hash: location.hash },
      { replace: true },
    );
  }, [location, navigate]);
  // The URL's value once present; until the effect has put it back, the last one seen.
  return parseScope(new URLSearchParams(location.search).get(SCOPE_PARAM)) ?? last.current;
}

export default function AppShell() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const scope = useKeepScopeInUrl();
  if (!user) return null;

  const items = NAV.filter((i) => !i.roles || i.roles.includes(user.role));

  return (
    <div className="flex h-full">
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-60 shrink-0 border-r border-gray-200 bg-white transition-transform lg:static lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 items-center justify-between border-b border-gray-200 px-4">
          <span className="flex items-center gap-2 font-display text-base font-extrabold tracking-tight text-gray-900">
            <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-indigo-600 text-white shadow-sm">
              <Activity className="size-4" aria-hidden />
            </span>
            Pure Insights
          </span>
          <button
            type="button"
            className="rounded p-1 text-gray-500 hover:bg-gray-100 lg:hidden"
            onClick={() => setOpen(false)}
            aria-label="Close menu"
          >
            <X className="size-4" />
          </button>
        </div>
        <nav aria-label="Main" className="p-2">
          {items.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={{ pathname: to, search: `?${SCOPE_PARAM}=${scope}` }}
              end={to === '/'}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[15px] ${
                  isActive
                    ? 'bg-accent-soft font-semibold text-accent-strong'
                    : 'text-gray-700 hover:bg-gray-100'
                }`
              }
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4 md:px-6">
          <button
            type="button"
            className="rounded p-1 text-gray-600 hover:bg-gray-100 lg:hidden"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="size-5" />
          </button>
          <LiveStatus />
          <ScopeSwitch />
          <div className="ml-auto flex items-center gap-1">
            {user.role === 'admin' && <AdminControls />}
            <NotificationBell />
            <Popover
              label={<Avatar email={user.email} />}
              ariaLabel="Account menu"
              panelClass="w-64 p-1"
              triggerClass="!px-1.5"
            >
              <div className="px-3 py-2">
                <p className="truncate text-sm font-medium text-gray-900">{user.email}</p>
                <div className="mt-1">
                  <RoleBadge role={user.role} />
                </div>
              </div>
              <hr className="my-1 border-gray-200" />
              <button
                type="button"
                onClick={() => void logout()}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
              >
                <LogOut className="size-4" aria-hidden />
                Sign out
              </button>
            </Popover>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          <Outlet />
        </main>
      </div>
      <CriticalPopup />
    </div>
  );
}
