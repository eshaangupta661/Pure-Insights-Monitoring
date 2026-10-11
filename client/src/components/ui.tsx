import { AlertTriangle, FileCode, Info, OctagonAlert, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RefreshStatus, Role, Severity } from '@pic/shared';
import { sqlFileUrl } from '../lib/links';

export function Card({
  title,
  subtitle,
  children,
  className = '',
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-gray-200 bg-white p-4 ${className}`}>
      {title && (
        <header className="mb-3">
          <h2 className="text-sm font-medium text-gray-900">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
        </header>
      )}
      {children}
    </section>
  );
}

const SEVERITY: Record<Severity, { label: string; icon: LucideIcon; cls: string }> = {
  CRITICAL: { label: 'Critical', icon: OctagonAlert, cls: 'bg-red-50 text-critical' },
  WARNING: { label: 'Warning', icon: AlertTriangle, cls: 'bg-amber-50 text-warning' },
  INFO: { label: 'Info', icon: Info, cls: 'bg-gray-100 text-gray-600' },
};

/** Severity colors appear only here and in severity-coded chart marks; always icon + label. */
export function SeverityBadge({ severity }: { severity: Severity }) {
  const { label, icon: Icon, cls } = SEVERITY[severity];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}
    >
      <Icon className="size-3" aria-hidden />
      {label}
    </span>
  );
}

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span className="rounded-full border border-gray-300 px-2 py-0.5 text-xs font-medium text-gray-700 capitalize">
      {role}
    </span>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="py-8 text-center">
      <p className="text-sm font-medium text-gray-700">{title}</p>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="py-8 text-center" role="alert">
      <p className="text-sm font-medium text-gray-700">Could not load this</p>
      <p className="mt-1 text-xs text-gray-500">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 text-sm text-accent hover:underline"
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-gray-100 ${className}`} aria-hidden />;
}

const REFRESH_LABEL: Record<RefreshStatus, string> = {
  SUCCESS: 'Success',
  FAILED: 'Failed',
  TIMED_OUT: 'Timed out',
  UNKNOWN: 'Unknown',
};
export const refreshLabel = (s: RefreshStatus): string => REFRESH_LABEL[s];

/** Refresh status as text with a small dot; failures are red only because they raise CRITICAL alerts. */
export function RefreshBadge({ status }: { status: RefreshStatus }) {
  const dot =
    status === 'SUCCESS' ? 'bg-gray-400' : status === 'UNKNOWN' ? 'bg-gray-300' : 'bg-critical';
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-gray-700">
      <span className={`size-2 rounded-full ${dot}`} aria-hidden />
      {REFRESH_LABEL[status]}
    </span>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const btn =
    'rounded border border-gray-300 bg-white px-2.5 py-1 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-white';
  return (
    <div className="flex items-center justify-between gap-3 pt-3 text-xs text-gray-500">
      <span className="tabular-nums">
        {from}–{to} of {total}
      </span>
      <span className="flex items-center gap-2">
        <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <span className="tabular-nums">
          {page} / {pages}
        </span>
        <button
          type="button"
          className={btn}
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          Next
        </button>
      </span>
    </div>
  );
}

/** Shared control styling so selects, inputs and buttons match. */
export const controlClass =
  'rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-800 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50';
export const primaryButtonClass =
  'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-strong disabled:opacity-50';
export const secondaryButtonClass =
  'rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50';

/** A small link to the /sql file that produced a widget's numbers. */
export function SqlLink({ file }: { file: string }) {
  return (
    <a
      href={sqlFileUrl(file)}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open sql/${file}`}
      className="inline-flex items-center gap-1 rounded border border-gray-200 px-1.5 py-0.5 font-mono text-xs text-gray-500 hover:border-accent hover:text-accent"
    >
      <FileCode className="size-3" aria-hidden />
      SQL
    </a>
  );
}

/** Card with the title row carrying the widget's SQL link on the right. */
export function Widget({
  title,
  subtitle,
  sql,
  children,
}: {
  title: string;
  subtitle?: string;
  sql: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-gray-900">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
        </div>
        <SqlLink file={sql} />
      </header>
      {children}
    </section>
  );
}
