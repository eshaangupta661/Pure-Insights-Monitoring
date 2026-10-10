import crypto from 'node:crypto';
import type { DuckDBValue } from '@duckdb/node-api';
import type { AuditAction, AuditLogEntry, AuthUser, Page } from '@pic/shared';
import type { AuditLogQuery } from '../api/schemas.js';
import { scopeSql, type Scope } from '../auth/scope.js';
import type { Queryable } from '../data/warehouse.js';
import { paginate } from '../http/pagination.js';

/** A JS Date as a DuckDB/Snowflake TIMESTAMP literal in UTC ('2026-10-10 23:12:04.123'). */
export function utcTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/** TIMESTAMP column → ISO 8601 UTC string with milliseconds. */
export const isoTimestampSql = (column: string) => `strftime(${column}, '%Y-%m-%dT%H:%M:%S.%gZ')`;

/**
 * Appends one AUDIT_LOG row. Pass the transaction handle when the audited change is a write,
 * so the change and its audit row commit or roll back together.
 */
export async function recordAudit(
  db: Queryable,
  actor: AuthUser,
  action: AuditAction,
  target: string,
  details: Record<string, unknown>,
  at: Date = new Date(),
): Promise<string> {
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO AUDIT_LOG (audit_id, logged_at, actor_email, action, target, details)
     VALUES ($1, $2::TIMESTAMP, $3, $4, $5, $6)`,
    [id, utcTimestamp(at), actor.email, action, target, JSON.stringify(details)],
  );
  return id;
}

/** Newest first. Only admins can call the route; an owner scope would see only their own actions. */
export async function listAuditLog(
  db: Queryable,
  scope: Scope,
  query: AuditLogQuery,
): Promise<Page<AuditLogEntry>> {
  const params: DuckDBValue[] = [];
  const where = [scopeSql(scope, 'actor_email', params)];
  if (query.action) {
    params.push(query.action);
    where.push(`action = $${params.length}`);
  }
  const page = await paginate<
    Omit<AuditLogEntry, 'details'> & { details: string; loggedAt: unknown }
  >(
    db,
    `SELECT audit_id AS id, ${isoTimestampSql('logged_at')} AS at, logged_at AS "loggedAt",
            actor_email AS "actorEmail", action, target, details
     FROM AUDIT_LOG WHERE ${where.join(' AND ')}`,
    params,
    '"loggedAt" DESC, id',
    query,
  );
  return {
    ...page,
    items: page.items.map(({ loggedAt: _loggedAt, details, ...rest }) => ({
      ...rest,
      details: JSON.parse(details) as Record<string, unknown>,
    })),
  };
}
