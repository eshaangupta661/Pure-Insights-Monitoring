import {
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
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import type { Role } from '@pic/shared';
import { useTrend } from '../api/queries';
import { useAuth } from '../auth/AuthProvider';
import { useAlerts, type ConnectionStatus } from '../realtime/AlertsProvider';
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

function ConnectionDot() {
  const { status } = useAlerts();
  const { label, dot } = STATUS[status];
  return (
    <span
      className="flex items-center gap-1.5 text-xs text-gray-600"
      role="status"
      title={`Live alerts: ${label}`}
    >
      <span className={`size-2 rounded-full ${dot}`} aria-hidden />
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}

/** "Snapshot 7/20 · live". The total comes from the API (one trend point per snapshot). */
function TickIndicator() {
  const { tick, status } = useAlerts();
  const total = useTrend().data?.points.length;
  if (!tick) return <span className="text-xs text-gray-400">Snapshot —</span>;
  const state = status !== 'connected' ? 'not live' : tick.paused ? 'paused' : 'live';
  return (
    <span
      className="text-xs text-gray-700 tabular-nums"
      title={`Snapshot date ${tick.snapshotDate}`}
    >
      Snapshot {tick.tick + 1}
      {total ? `/${total}` : ''} ·{' '}
      <span className={state === 'live' ? 'text-accent' : 'text-gray-500'}>{state}</span>
    </span>
  );
}

export default function AppShell() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  if (!user) return null;

  const items = NAV.filter((i) => !i.roles || i.roles.includes(user.role));

  return (
    <div className="flex h-full">
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-56 shrink-0 border-r border-gray-200 bg-white transition-transform lg:static lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-14 items-center justify-between border-b border-gray-200 px-4">
          <span className="text-sm font-semibold text-gray-900">Pure Insights</span>
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
              to={to}
              end={to === '/'}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-3 py-2 text-sm ${
                  isActive
                    ? 'bg-accent-soft font-medium text-accent-strong'
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
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4">
          <button
            type="button"
            className="rounded p-1 text-gray-600 hover:bg-gray-100 lg:hidden"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="size-5" />
          </button>
          <TickIndicator />
          <ConnectionDot />
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-xs text-gray-500 sm:inline">{user.email}</span>
            <RoleBadge role={user.role} />
            <button
              type="button"
              onClick={() => void logout()}
              className="flex items-center gap-1 rounded p-1 text-xs text-gray-600 hover:bg-gray-100"
              aria-label="Sign out"
            >
              <LogOut className="size-4" aria-hidden />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
