import type { AlertRuleId, RefreshStatus, Severity } from '@pic/shared';
import { config } from '../config.js';

/** One report at one tick: its snapshot row, or an injected incident (synthetic). */
export interface Reading {
  reportId: string;
  reportName: string;
  refreshStatus: RefreshStatus;
  loadTimeSec: number;
  synthetic: boolean;
}

/** What a rule reports for an unhealthy reading. */
export interface Violation {
  ruleId: AlertRuleId;
  severity: Severity;
  value: number;
  threshold: number;
  message: string;
}

export const SEVERITY_RANK: Record<Severity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

export const ALERT_RULE_IDS: readonly AlertRuleId[] = [
  'LATENCY',
  'REFRESH_FAILED',
  'REFRESH_UNKNOWN',
];

/** Latency: > LATENCY_WARNING_SEC is WARNING, > LATENCY_CRITICAL_SEC is CRITICAL (strictly greater). */
export function latencyRule(r: Reading): Violation | null {
  const critical = r.loadTimeSec > config.LATENCY_CRITICAL_SEC;
  if (!critical && !(r.loadTimeSec > config.LATENCY_WARNING_SEC)) return null;
  const threshold = critical ? config.LATENCY_CRITICAL_SEC : config.LATENCY_WARNING_SEC;
  return {
    ruleId: 'LATENCY',
    severity: critical ? 'CRITICAL' : 'WARNING',
    value: r.loadTimeSec,
    threshold,
    message: `Load time ${r.loadTimeSec}s > ${threshold}s`,
  };
}

/** FAILED / TIMED_OUT refresh is CRITICAL. value 1 = one failed refresh at this tick. */
export function refreshFailedRule(r: Reading): Violation | null {
  if (!(config.FAILED_REFRESH_STATUSES as readonly string[]).includes(r.refreshStatus)) return null;
  return {
    ruleId: 'REFRESH_FAILED',
    severity: 'CRITICAL',
    value: 1,
    threshold: 1,
    message: `Refresh ${r.refreshStatus}`,
  };
}

/** UNKNOWN refresh status (DQ07) is INFO. */
export function refreshUnknownRule(r: Reading): Violation | null {
  if (r.refreshStatus !== 'UNKNOWN') return null;
  return {
    ruleId: 'REFRESH_UNKNOWN',
    severity: 'INFO',
    value: 1,
    threshold: 1,
    message: 'Refresh status UNKNOWN',
  };
}

const RULES = [latencyRule, refreshFailedRule, refreshUnknownRule];

/** Every rule a reading violates (0–2: latency and one refresh rule can both fire). */
export function evaluateReading(reading: Reading): Violation[] {
  return RULES.map((rule) => rule(reading)).filter((v): v is Violation => v !== null);
}
