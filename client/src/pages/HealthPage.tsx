import { useQuery } from '@tanstack/react-query';
import type { HealthResponse } from '@pic/shared';

async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch('/health');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<HealthResponse>;
}

export default function HealthPage() {
  const { data, error, isPending } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    refetchInterval: 5000,
  });

  return (
    <main className="mx-auto max-w-md p-8 text-gray-800">
      <h1 className="text-xl font-semibold">Pure Insights Command Center</h1>
      <p className="mt-1 text-sm text-gray-500">Phase 0 scaffold: server health check</p>
      <div className="mt-6 rounded border border-gray-200 p-4 text-sm">
        {isPending && <p>Waking up the server…</p>}
        {error && <p className="text-gray-600">Server unreachable: {error.message}</p>}
        {data && (
          <dl className="grid grid-cols-2 gap-2">
            <dt className="text-gray-500">Status</dt>
            <dd>{data.status}</dd>
            <dt className="text-gray-500">Tick</dt>
            <dd>{data.tick}</dd>
            <dt className="text-gray-500">Uptime</dt>
            <dd>{data.uptime.toFixed(1)}s</dd>
          </dl>
        )}
      </div>
    </main>
  );
}
