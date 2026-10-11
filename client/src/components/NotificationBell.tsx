import { Bell } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { valueVsThreshold } from '../lib/notifications';
import { useAlerts } from '../realtime/AlertsProvider';
import { SeverityBadge } from './ui';

/**
 * Header bell: unread count and the most recent live WARNING/CRITICAL alerts (newest first),
 * with "mark all read" and the "mute pop-ups" toggle. Closes on outside click and Escape.
 */
export default function NotificationBell() {
  const { notifications, unread, markAllRead, mutePopups, setMutePopups } = useAlerts();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="true"
        className="relative rounded p-1 text-gray-600 hover:bg-gray-100"
      >
        <Bell className="size-5" aria-hidden />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-critical px-1 text-[10px] leading-none font-semibold text-white tabular-nums">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-50 mt-2 w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-gray-200 bg-white shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
            <h2 className="text-sm font-medium text-gray-900">Notifications</h2>
            <button
              type="button"
              onClick={markAllRead}
              disabled={unread === 0}
              className="text-xs text-accent hover:underline disabled:text-gray-400 disabled:no-underline"
            >
              Mark all read
            </button>
          </div>
          {notifications.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-gray-500">
              No new alerts since you signed in.
            </p>
          ) : (
            <ul className="max-h-96 divide-y divide-gray-100 overflow-y-auto">
              {notifications.map(({ key, alert: a, read }) => (
                <li key={key}>
                  <Link
                    to={`/reports/${a.reportId}`}
                    onClick={() => setOpen(false)}
                    className={`flex gap-2 px-3 py-2 text-sm hover:bg-gray-50 ${read ? '' : 'bg-accent-soft/40'}`}
                  >
                    <span
                      className={`mt-1.5 size-1.5 shrink-0 rounded-full ${read ? '' : 'bg-accent'}`}
                      aria-label={read ? undefined : 'Unread'}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <SeverityBadge severity={a.severity} />
                        <span className="text-xs text-gray-500 tabular-nums">
                          Snapshot {a.lastSeenTick + 1}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate font-medium text-gray-900">
                        {a.reportName}{' '}
                        <span className="font-normal text-gray-500">{a.reportId}</span>
                      </span>
                      <span className="block text-xs text-gray-600 tabular-nums">
                        {valueVsThreshold(a)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <label className="flex cursor-pointer items-center justify-between gap-2 border-t border-gray-200 px-3 py-2 text-xs text-gray-700">
            <span>Mute critical pop-ups</span>
            <input
              type="checkbox"
              checked={mutePopups}
              onChange={(e) => setMutePopups(e.target.checked)}
              className="size-4 accent-accent"
            />
          </label>
        </div>
      )}
    </div>
  );
}
