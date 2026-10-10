import type { DuckDBValue } from '@duckdb/node-api';
import type { DataQualityResponse, DataQualityRule, DqFlag, DqRuleId } from '@pic/shared';
import { scopeSql, type Scope } from '../auth/scope.js';
import type { Queryable } from '../data/warehouse.js';
import { DQ_RULES } from '../ingest/rules.js';
import { RESULTS_SCHEMA } from '../sql/runner.js';

const SAMPLES_PER_RULE = 3;

/**
 * DQ rule counts over the snapshot rows of the reports in scope (all 20 snapshots of each), read
 * from the dq_flags ingest stored. Unscoped, the counts equal data/dq_summary.json.
 */
export async function getDataQuality(db: Queryable, scope: Scope): Promise<DataQualityResponse> {
  const params: DuckDBValue[] = [];
  const scoped = `
    SELECT s.row_idx, s.report_id, s.dq_flags
    FROM REPORT_SNAPSHOTS s
    JOIN REPORT_CURRENT_OWNER o ON o.report_id = s.report_id
    WHERE ${scopeSql(scope, 'o.current_owner', params)}`;

  const [totals] = await db.query<{ rows: number; quarantined: number }>(
    `WITH scoped AS (${scoped})
     SELECT (SELECT COUNT(*) FROM scoped)::INTEGER AS rows,
            (SELECT COUNT(*) FROM QUARANTINE q WHERE q.row_idx IN (SELECT row_idx FROM scoped))::INTEGER
              AS quarantined`,
    params,
  );

  // Per flag: row count, and the first few reports in row order (by each report's first hit).
  const perFlag = await db.query<{ flag: DqFlag; rows: number; samples: string[] }>(
    `WITH scoped AS (${scoped}),
     hits AS (SELECT row_idx, report_id, UNNEST(dq_flags) AS flag FROM scoped),
     first_hit AS (SELECT flag, report_id, MIN(row_idx) AS first_row FROM hits GROUP BY flag, report_id)
     SELECT h.flag,
            (SELECT COUNT(*) FROM hits x WHERE x.flag = h.flag)::INTEGER AS rows,
            LIST(h.report_id ORDER BY h.first_row)[1:${SAMPLES_PER_RULE}] AS samples
     FROM first_hit h
     GROUP BY h.flag`,
    params,
  );
  const byFlag = new Map(perFlag.map((f) => [f.flag, f]));

  const meta = await db.query<{
    ruleId: DqRuleId;
    ruleName: string;
    severity: DataQualityRule['severity'];
    treatment: string;
  }>(
    `SELECT rule_id AS "ruleId", rule_name AS "ruleName", severity, treatment
     FROM DQ_RESULTS ORDER BY rule_id`,
  );
  const flagOf = new Map(DQ_RULES.map((r) => [r.id, r.flag]));
  const rules: DataQualityRule[] = meta.map((m) => {
    const flag = flagOf.get(m.ruleId);
    if (!flag) throw new Error(`DQ_RESULTS has unknown rule ${m.ruleId}`);
    const hit = byFlag.get(flag);
    return { ...m, flag, rowsAffected: hit?.rows ?? 0, sampleReportIds: hit?.samples ?? [] };
  });

  const checks = await db.query<DataQualityResponse['checks'][number]>(
    `SELECT rule_id AS "ruleId", status FROM ${RESULTS_SCHEMA}.DQ_CHECKS ORDER BY rule_id`,
  );

  return {
    scopedRows: totals?.rows ?? 0,
    rules,
    quarantinedRows: totals?.quarantined ?? 0,
    checks,
  };
}
