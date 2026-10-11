import { Loader2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

const POLL_MS = 2000;
const REQUEST_TIMEOUT_MS = 5000;
/** Don't flash the waking screen when the server answers right away. */
const GRACE_MS = 600;

async function isHealthy(signal: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch('/health', { signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Holds the app back until GET /health answers. On Render's free tier the service sleeps after
 * 15 minutes idle and takes up to a minute to wake; until then every request would fail, so the
 * first load polls instead. Once the server has answered, children render and stay rendered
 * (later outages are shown by the connection indicator and per-query errors).
 */
export default function ServerGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [showWaking, setShowWaking] = useState(false);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    void (async () => {
      while (!stopped) {
        // A fresh controller per attempt: aborting one slow request must not poison the next.
        const controller = new AbortController();
        const abort = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        const ok = await isHealthy(controller.signal);
        clearTimeout(abort);
        if (stopped) return;
        if (ok) return setReady(true);
        await new Promise((resolve) => (timer = setTimeout(resolve, POLL_MS)));
      }
    })();

    const grace = setTimeout(() => setShowWaking(true), GRACE_MS);
    const clock = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(grace);
      clearInterval(clock);
    };
  }, []);

  if (ready) return <>{children}</>;
  if (!showWaking) return null;

  return (
    <main className="flex h-full items-center justify-center p-6">
      <div className="max-w-sm text-center" role="status">
        <Loader2 className="mx-auto size-6 animate-spin text-accent" aria-hidden />
        <h1 className="mt-4 text-base font-medium text-gray-900">Waking up the server…</h1>
        <p className="mt-2 text-sm text-gray-600">
          The free hosting plan puts the service to sleep when idle. The first request can take up
          to a minute; this page continues on its own.
        </p>
        <p className="mt-3 text-xs text-gray-400 tabular-nums">{seconds}s</p>
      </div>
    </main>
  );
}
