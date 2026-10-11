import { useQuery } from '@tanstack/react-query';
import { BookOpen, CheckCircle2, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { DataQualityResponse, DqSeverity } from '@pic/shared';
import { api } from '../api/http';
import { ErrorState, Skeleton, SqlLink } from '../components/ui';
import { formatInt } from '../lib/format';
import { docUrl } from '../lib/links';

const SEVERITY_STYLE: Record<DqSeverity, string> = {
  high: 'bg-red-50 text-critical',
  medium: 'bg-amber-50 text-warning',
  low: 'bg-gray-100 text-gray-600',
  info: 'bg-gray-100 text-gray-600',
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900 tabular-nums">{value}</p>
    </div>
  );
}

export default function DataQualityPage() {
  const dq = useQuery({
    queryKey: ['data-quality'],
    queryFn: () => api<DataQualityResponse>('/data-quality'),
  });
  const data = dq.data;
  const status = new Map(data?.checks.map((c) => [c.ruleId, c.status]));
  const failing = data?.checks.filter((c) => c.status === 'FAIL').length ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Data Quality</h1>
          <p className="text-xs text-gray-500">
            Rules run over every snapshot of the reports in your scope. Rows are flagged, never
            silently dropped.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={docUrl('DATA_QUALITY.md')}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
          >
            <BookOpen className="size-4" aria-hidden />
            DATA_QUALITY.md
          </a>
          <SqlLink file="02_data_quality.sql" />
        </div>
      </div>

      {dq.isError && <ErrorState message={dq.error.message} onRetry={() => void dq.refetch()} />}
      {dq.isPending && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      )}

      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Snapshot rows checked" value={formatInt(data.scopedRows)} />
            <Stat
              label="Rules with findings"
              value={`${data.rules.filter((r) => r.rowsAffected > 0).length} / ${data.rules.length}`}
            />
            <Stat label="Rows quarantined" value={formatInt(data.quarantinedRows)} />
            <Stat
              label="SQL cross-checks"
              value={failing === 0 ? 'All pass' : `${failing} failing`}
            />
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.rules.map((rule) => {
              const check = status.get(rule.ruleId);
              return (
                <article
                  key={rule.ruleId}
                  className="flex flex-col rounded-lg border border-gray-200 bg-white p-4"
                >
                  <header className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-mono text-xs text-gray-500">{rule.ruleId}</p>
                      <h2 className="text-sm font-medium text-gray-900">{rule.ruleName}</h2>
                    </div>
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-medium capitalize ${SEVERITY_STYLE[rule.severity]}`}
                    >
                      {rule.severity}
                    </span>
                  </header>

                  <p className="mt-3 text-2xl font-semibold text-gray-900 tabular-nums">
                    {formatInt(rule.rowsAffected)}
                    <span className="ml-1.5 text-sm font-normal text-gray-500">
                      of {formatInt(data.scopedRows)} rows
                    </span>
                  </p>

                  <p className="mt-2 text-sm text-gray-700">
                    <span className="text-xs text-gray-500">Treatment: </span>
                    {rule.treatment}
                  </p>

                  <div className="mt-3">
                    <p className="text-xs text-gray-500">Sample reports</p>
                    {rule.sampleReportIds.length === 0 ? (
                      <p className="text-sm text-gray-500">None flagged</p>
                    ) : (
                      <ul className="mt-1 flex flex-wrap gap-1.5">
                        {rule.sampleReportIds.map((id) => (
                          <li key={id}>
                            <Link
                              to={`/reports/${id}`}
                              className="rounded border border-gray-200 px-1.5 py-0.5 text-xs text-gray-700 hover:border-accent hover:text-accent"
                            >
                              {id}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <footer className="mt-auto flex items-center gap-1.5 pt-3 text-xs text-gray-500">
                    {check === 'PASS' ? (
                      <>
                        <CheckCircle2 className="size-3.5 text-gray-400" aria-hidden />
                        SQL result matches the TypeScript rule
                      </>
                    ) : check === 'FAIL' ? (
                      <>
                        <XCircle className="size-3.5 text-critical" aria-hidden />
                        <span className="text-critical">
                          SQL result differs from the TypeScript rule
                        </span>
                      </>
                    ) : null}
                  </footer>
                </article>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
