import { BellOff, OctagonAlert, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Alert } from '@pic/shared';
import { useAuth } from '../auth/AuthProvider';
import { POPUP_MS, canAck, streakLabel, valueVsThreshold } from '../lib/notifications';
import { useAlerts } from '../realtime/AlertsProvider';

/**
 * One CRITICAL alert card at a time, bottom right, with "+N more" for the queue. Closes itself
 * after POPUP_MS; hovering (or focusing) the card pauses the countdown. "Mute" on the card (or
 * the bell's toggle) closes the queue and stops new cards; criticals still reach the bell,
 * where pop-ups can be turned back on.
 */
export default function CriticalPopup() {
  const { popups, dismissPopup } = useAlerts();
  const [first] = popups;
  if (!first) return null;
  // key: a new card gets a fresh countdown and error state.
  return <PopupCard key={first.id} alert={first} more={popups.length - 1} dismiss={dismissPopup} />;
}

function PopupCard({
  alert: a,
  more,
  dismiss,
}: {
  alert: Alert;
  more: number;
  dismiss: (alertId: string) => void;
}) {
  const { user } = useAuth();
  const { ack, setMutePopups } = useAlerts();
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remaining = useRef(POPUP_MS);
  const id = a.id;
  const onDismiss = useCallback(() => dismiss(id), [dismiss, id]);

  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const timer = setTimeout(onDismiss, remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [paused, onDismiss]);

  const acknowledge = () => {
    setBusy(true);
    setError(null);
    ack(a.id)
      .then(onDismiss)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not acknowledge');
        setBusy(false);
      });
  };

  return (
    <div
      role="alert"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="fixed right-3 bottom-3 z-50 w-[calc(100vw-1.5rem)] max-w-72 rounded-lg border border-gray-200 border-l-4 border-l-critical bg-white p-3 text-xs shadow-lg sm:right-4 sm:bottom-4 sm:max-w-sm sm:p-4 sm:text-sm"
    >
      <div className="flex items-start gap-2">
        <OctagonAlert className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold tracking-wide text-critical uppercase">Critical</p>
          <p className="mt-0.5 truncate font-medium text-gray-900">{a.reportName}</p>
          <p className="text-gray-500">{a.reportId}</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
        >
          <X className="size-4" />
        </button>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-gray-700">
        <dt className="text-gray-500">Owner</dt>
        <dd className="truncate">{a.ownerEmail ?? 'Unowned (orphaned)'}</dd>
        <dt className="text-gray-500">Value</dt>
        <dd className="tabular-nums">{valueVsThreshold(a)}</dd>
        <dt className="text-gray-500">Streak</dt>
        <dd>
          {streakLabel(a.streak)} (snapshot {a.lastSeenTick + 1})
        </dd>
      </dl>
      {error && <p className="mt-2 text-critical">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Link
          to={`/reports/${a.reportId}`}
          onClick={onDismiss}
          className="rounded-md border border-gray-300 px-2.5 py-1 text-gray-700 hover:bg-gray-50"
        >
          View report
        </Link>
        {user && canAck(user, a) && (
          <button
            type="button"
            onClick={acknowledge}
            disabled={busy}
            className="rounded-md bg-accent px-2.5 py-1 font-medium text-white hover:bg-accent-strong disabled:opacity-60"
          >
            {busy ? 'Acknowledging…' : 'Acknowledge'}
          </button>
        )}
        <button
          type="button"
          onClick={() => setMutePopups(true)}
          title="Stop critical pop-ups (turn them back on from the bell)"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-gray-600 hover:bg-gray-100 hover:text-gray-900"
        >
          <BellOff className="size-3.5" aria-hidden />
          Mute
        </button>
        {more > 0 && <span className="ml-auto text-gray-500 tabular-nums">+{more} more</span>}
      </div>
    </div>
  );
}
