import type { HealthRing, SystemHealth } from '@pic/shared';
import { formatInt, formatPercent } from '../lib/format';
import { changePoints, formatChange, weakestRing, type HealthKey } from '../lib/health';
import { Card } from './ui';

type Basis = 'today' | 'period';

const SIZE = 168;
const STROKE = 12;
const GAP = 4;
const ACCENT = '#2a78d6';
const TRACK = '#e5e7eb';
const MUTED = '#9ca3af';

const unit = (basis: Basis) =>
  basis === 'today'
    ? 'reports at the current snapshot'
    : 'report snapshots from the first to the current one';

interface RingSpec {
  key: HealthKey;
  label: string;
  /** Plain-text formula for the tooltip. */
  formula: (basis: Basis, warningSec: number | undefined) => string;
}

/** Outer to inner ring. */
const RINGS: readonly RingSpec[] = [
  {
    key: 'refresh',
    label: 'Refresh success',
    formula: (b) =>
      `Refresh success = ${unit(b)} with status SUCCESS ÷ all of them. FAILED, TIMED_OUT and UNKNOWN count as not successful.`,
  },
  {
    key: 'latency',
    label: 'Within load-time limit',
    formula: (b, s) =>
      `Within limit = ${unit(b)} with load time ≤ ${s ?? 'the warning threshold'} s ÷ all of them. The complement of "slow".`,
  },
  {
    key: 'ownership',
    label: 'Ownership coverage',
    formula: (b) =>
      `Ownership coverage = ${unit(b)} that have an owner ÷ all of them. An admin override counts as an owner.`,
  },
];

function Rings({ health, weakest }: { health: SystemHealth; weakest: HealthKey | null }) {
  const centre = SIZE / 2;
  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden>
      {RINGS.map((r, i) => {
        const radius = centre - STROKE / 2 - i * (STROKE + GAP);
        const circumference = 2 * Math.PI * radius;
        const rate = health[r.key].rate ?? 0;
        return (
          <g key={r.key} transform={`rotate(-90 ${centre} ${centre})`}>
            <circle
              cx={centre}
              cy={centre}
              r={radius}
              fill="none"
              stroke={TRACK}
              strokeWidth={STROKE}
            />
            <circle
              cx={centre}
              cy={centre}
              r={radius}
              fill="none"
              stroke={r.key === weakest ? ACCENT : MUTED}
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={`${circumference * rate} ${circumference}`}
            />
          </g>
        );
      })}
    </svg>
  );
}

function RingRow({
  spec,
  ring,
  basis,
  warningSec,
  isWeakest,
}: {
  spec: RingSpec;
  ring: HealthRing;
  basis: Basis;
  warningSec: number | undefined;
  isWeakest: boolean;
}) {
  return (
    <li className="group relative flex items-baseline justify-between gap-4 py-1.5">
      <button
        type="button"
        className="cursor-help text-left text-sm text-gray-700 underline decoration-dotted underline-offset-2"
        aria-describedby={`health-tip-${spec.key}`}
      >
        {spec.label}
        {isWeakest && <span className="ml-1.5 text-xs font-medium text-accent">weakest</span>}
      </button>
      <span className="text-right text-sm tabular-nums text-gray-900">
        <span className="font-semibold">{ring.rate === null ? '—' : formatPercent(ring.rate)}</span>{' '}
        <span className="text-xs text-gray-500">
          {formatInt(ring.count)} of {formatInt(ring.total)}
        </span>
      </span>
      <span
        id={`health-tip-${spec.key}`}
        role="tooltip"
        className="pointer-events-none absolute top-full left-0 z-10 hidden w-72 rounded-md border border-gray-200 bg-white p-2 text-xs text-gray-700 shadow-md group-focus-within:block group-hover:block"
      >
        {spec.formula(basis, warningSec)}
      </span>
    </li>
  );
}

/** Three concentric rings (outer to inner: refresh success, within load-time limit, ownership). */
export function SystemHealthCard({
  health,
  basis,
  warningSec,
}: {
  health: SystemHealth;
  basis: Basis;
  warningSec: number | undefined;
}) {
  const weakest = weakestRing(health);
  const spec = RINGS.find((r) => r.key === weakest);
  const ring = weakest ? health[weakest] : null;
  const vs = basis === 'today' ? 'the previous snapshot' : 'the period up to the previous snapshot';
  return (
    <Card
      title="System health"
      subtitle={basis === 'today' ? 'Current snapshot' : 'Period to date'}
    >
      <div className="flex flex-wrap items-center gap-6">
        <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
          <Rings health={health} weakest={weakest} />
          <div className="absolute inset-0 flex flex-col items-center justify-center px-12 text-center">
            {ring && spec ? (
              <>
                <span className="text-xl font-semibold text-gray-900 tabular-nums">
                  {ring.rate === null ? '—' : formatPercent(ring.rate)}
                </span>
                <span className="text-[10px] leading-tight text-gray-500">
                  Weakest: {spec.label}
                </span>
                <span className="mt-0.5 text-[10px] leading-tight text-gray-700 tabular-nums">
                  {formatChange(changePoints(ring))}
                </span>
              </>
            ) : (
              <span className="text-xs text-gray-500">No reports</span>
            )}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <ul className="divide-y divide-gray-100">
            {RINGS.map((r) => (
              <RingRow
                key={r.key}
                spec={r}
                ring={health[r.key]}
                basis={basis}
                warningSec={warningSec}
                isWeakest={r.key === weakest}
              />
            ))}
          </ul>
          <p className="mt-2 text-xs text-gray-500">
            Rings run outer to inner in the order listed. The centre change is in percentage points
            vs {vs}. Hover or focus a label for its formula.
          </p>
        </div>
      </div>
    </Card>
  );
}
