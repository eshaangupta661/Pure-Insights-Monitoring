import type { AuthUser, OwnerOverrideRequest } from '@pic/shared';
import { scopeSql, type Scope } from '../auth/scope.js';
import type { Warehouse } from '../data/warehouse.js';
import { recordAudit, utcTimestamp } from './audit.js';

export interface OwnerChange {
  reportId: string;
  before: string | null;
  after: string | null;
}

/**
 * Sets a report's owner: upserts OWNER_OVERRIDES and appends AUDIT_LOG in one transaction, so
 * neither exists without the other. Returns null (and writes nothing) when the report doesn't
 * exist or is outside `scope`. REPORT_CURRENT_OWNER, and with it /sql 04–07, follow at once.
 */
export async function setOwnerOverride(
  warehouse: Warehouse,
  scope: Scope,
  actor: AuthUser,
  reportId: string,
  request: OwnerOverrideRequest,
): Promise<OwnerChange | null> {
  return warehouse.transaction(async (tx) => {
    const params = [reportId];
    const [current] = await tx.query<{ owner: string | null; wasOverridden: boolean }>(
      `SELECT current_owner AS owner, is_overridden AS "wasOverridden"
       FROM REPORT_CURRENT_OWNER
       WHERE report_id = $1 AND ${scopeSql(scope, 'current_owner', params)}`,
      params,
    );
    if (!current) return null;

    const now = new Date();
    const reason = request.reason ?? null;
    await tx.run(
      `INSERT INTO OWNER_OVERRIDES (report_id, owner_email, set_by, set_at, reason)
       VALUES ($1, $2, $3, $4::TIMESTAMP, $5)
       ON CONFLICT (report_id) DO UPDATE SET
         owner_email = excluded.owner_email, set_by = excluded.set_by,
         set_at = excluded.set_at, reason = excluded.reason`,
      [reportId, request.ownerEmail, actor.email, utcTimestamp(now), reason],
    );
    await recordAudit(
      tx,
      actor,
      'OWNER_OVERRIDE',
      reportId,
      {
        before: current.owner,
        after: request.ownerEmail,
        replacedOverride: current.wasOverridden,
        reason,
      },
      now,
    );
    return { reportId, before: current.owner, after: request.ownerEmail };
  });
}
