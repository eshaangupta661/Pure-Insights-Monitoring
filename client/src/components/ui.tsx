import { AlertTriangle, Info, OctagonAlert, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Role, Severity } from '@pic/shared';

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
