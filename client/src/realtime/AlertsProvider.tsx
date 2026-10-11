import { useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ALERTS_NAMESPACE,
  type Alert,
  type AlertAckResponse,
  type ClientToServerEvents,
  type OverviewKpis,
  type Page,
  type ServerToClientEvents,
  type TickEvent,
} from '@pic/shared';
import {
  ALERTS_KEY,
  ANOMALIES_KEY,
  OVERVIEW_KEY,
  PERIOD_KEY,
  REPLAY_KEY,
  REPORTS_KEY,
  TREND_KEY,
} from '../api/queries';
import { ApiRequestError, api } from '../api/http';
import { useAuth } from '../auth/AuthProvider';
import { useToast } from '../toast/ToastProvider';

/** `connecting` = first attempt; `reconnecting` = lost the link, backing off; `offline` = gave up. */
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

interface AlertsState {
  status: ConnectionStatus;
  /** Latest `tick` event (or null before the first). */
  tick: TickEvent | null;
  /** Active (OPEN + ACKNOWLEDGED) alerts in the caller's scope, most severe first. */
  alerts: Alert[];
  /** Acknowledge over the socket; rejects with the server's error message. */
  ack: (alertId: string) => Promise<Alert>;
}

type AlertsSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const AlertsContext = createContext<AlertsState | null>(null);

/** Critical alerts arriving within this window share one toast. */
const TOAST_BATCH_MS = 400;
const REFRESH_DEBOUNCE_MS = 300;

const SEVERITY_RANK = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const;

export function sortAlerts(alerts: Iterable<Alert>): Alert[] {
  return [...alerts].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.lastSeenTick - a.lastSeenTick ||
      a.id.localeCompare(b.id),
  );
}

/** All active alerts via REST, following pagination (used to re-sync after a reconnect). */
async function fetchActiveAlerts(): Promise<Alert[]> {
  const items: Alert[] = [];
  for (let page = 1; ; page++) {
    const res = await api<Page<Alert>>(`/alerts?pageSize=100&page=${page}`);
    items.push(...res.items);
    if (res.items.length === 0 || items.length >= res.total) break;
  }
  return items.filter((a) => a.status !== 'RESOLVED');
}

/**
 * Owns the single Socket.IO connection of a signed-in session (mounted inside the authenticated
 * shell). The browser sends the `pic_token` cookie with the same-origin handshake; nothing is
 * passed in `auth`. Reconnection uses Socket.IO's exponential backoff with jitter, and every
 * reconnect is followed by a `GET /alerts` so a missed event can't leave the list stale.
 */
export function AlertsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { logout } = useAuth();
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [tick, setTick] = useState<TickEvent | null>(null);
  const [byId, setById] = useState<ReadonlyMap<string, Alert>>(new Map());
  const socketRef = useRef<AlertsSocket | null>(null);

  useEffect(() => {
    const socket: AlertsSocket = io(ALERTS_NAMESPACE, {
      withCredentials: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 15_000,
      randomizationFactor: 0.5,
    });
    socketRef.current = socket;

    let hasConnected = false;
    /** Bumped by every alert event, so a slower REST re-sync never overwrites newer socket data. */
    let version = 0;
    /** `${id}:${severity}` already toasted, so reconnect snapshots and updates don't repeat. */
    const toasted = new Set<string>();

    // A tick can open dozens of alerts at once; criticals arriving together become one toast.
    let pendingCritical: Alert[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flushToasts = () => {
      const batch = pendingCritical;
      pendingCritical = [];
      const [first] = batch;
      if (!first) return;
      if (batch.length === 1) {
        toast({ title: `Critical: ${first.reportName}`, body: first.message, to: '/alerts' });
      } else {
        toast({
          title: `${batch.length} new critical alerts`,
          body: `${first.reportName}: ${first.message}, and ${batch.length - 1} more`,
          to: '/alerts',
        });
      }
    };
    const maybeToast = (alert: Alert) => {
      const key = `${alert.id}:${alert.severity}`;
      if (alert.severity !== 'CRITICAL' || alert.status !== 'OPEN' || toasted.has(key)) return;
      toasted.add(key);
      pendingCritical.push(alert);
      clearTimeout(flushTimer);
      clearTimeout(refreshTimer);
      flushTimer = setTimeout(flushToasts, TOAST_BATCH_MS);
    };
    // Pages that list alerts or reports over REST refetch shortly after the live state changes.
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshLists = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ALERTS_KEY });
        void queryClient.invalidateQueries({ queryKey: REPORTS_KEY });
      }, REFRESH_DEBOUNCE_MS);
    };
    const upsert = (alert: Alert) =>
      setById((prev) => {
        const next = new Map(prev);
        if (alert.status === 'RESOLVED') next.delete(alert.id);
        else next.set(alert.id, alert);
        return next;
      });

    // Alerts already active when the socket (re)connects are not news: remember, don't toast.
    socket.on('alert:snapshot', (alerts) => {
      version++;
      refreshLists();
      for (const a of alerts) toasted.add(`${a.id}:${a.severity}`);
      setById(new Map(alerts.map((a) => [a.id, a])));
    });
    socket.on('alert:opened', (alert) => {
      version++;
      refreshLists();
      upsert(alert);
      maybeToast(alert);
    });
    socket.on('alert:updated', (alert) => {
      version++;
      refreshLists();
      upsert(alert);
      maybeToast(alert); // an escalation to CRITICAL is news
    });
    socket.on('tick', (event) => {
      setTick(event);
      refreshLists();
      void queryClient.invalidateQueries({ queryKey: REPLAY_KEY });
      void queryClient.invalidateQueries({ queryKey: TREND_KEY });
      void queryClient.invalidateQueries({ queryKey: PERIOD_KEY });
      void queryClient.invalidateQueries({ queryKey: ANOMALIES_KEY });
    });
    socket.on('kpi:update', (kpis: OverviewKpis) => {
      queryClient.setQueryData(OVERVIEW_KEY, kpis);
    });

    socket.on('connect', () => {
      setStatus('connected');
      if (hasConnected) {
        const startedAt = version;
        void fetchActiveAlerts()
          .then((alerts) => {
            if (version === startedAt) setById(new Map(alerts.map((a) => [a.id, a])));
          })
          .catch(() => undefined); // the server re-sends alert:snapshot on connect anyway
        void queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
      }
      hasConnected = true;
    });
    socket.on('disconnect', (reason) => {
      if (reason === 'io server disconnect') {
        // The server closed us (JWT expiry, or a failed welcome). Sign out if the session is
        // gone, else connect again; the client does not retry these by itself.
        api('/auth/me')
          .then(() => socket.connect())
          .catch((err: unknown) => {
            if (err instanceof ApiRequestError && err.status === 401) void logout();
            else setStatus('reconnecting');
          });
        return;
      }
      if (reason !== 'io client disconnect') setStatus('reconnecting');
    });
    socket.on('connect_error', (err) => {
      const code = (err as Error & { data?: { code?: string } }).data?.code;
      // A handshake the server rejected is not retried by Socket.IO; transport errors are.
      if (code === 'UNAUTHENTICATED') void logout();
      else if (!socket.active) setStatus('offline');
      else setStatus(hasConnected ? 'reconnecting' : 'connecting');
    });
    socket.io.on('reconnect_failed', () => setStatus('offline'));

    return () => {
      clearTimeout(flushTimer);
      clearTimeout(refreshTimer);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [queryClient, toast, logout]);

  const ack = useCallback(
    (alertId: string) =>
      new Promise<Alert>((resolve, reject) => {
        const socket = socketRef.current;
        if (!socket?.connected) return reject(new Error('Not connected'));
        socket
          .timeout(8000)
          .emit('alert:ack', { alertId }, (err: Error | null, res?: AlertAckResponse) => {
            if (err || !res) return reject(new Error('The server did not answer'));
            if (res.ok) resolve(res.alert);
            else reject(new Error(res.error.message));
          });
      }),
    [],
  );

  const alerts = useMemo(() => sortAlerts(byId.values()), [byId]);
  const value = useMemo(() => ({ status, tick, alerts, ack }), [status, tick, alerts, ack]);
  return <AlertsContext.Provider value={value}>{children}</AlertsContext.Provider>;
}

/** Live alert state for the signed-in session: connection status, replay tick, active alerts. */
export function useAlerts(): AlertsState {
  const ctx = useContext(AlertsContext);
  if (!ctx) throw new Error('useAlerts outside AlertsProvider');
  return ctx;
}
