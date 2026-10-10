import type { DuckDBValue } from '@duckdb/node-api';
import type { AuthUser } from '@pic/shared';

/**
 * What a user may see. Owners see only reports whose current owner (REPORT_CURRENT_OWNER) is
 * their email; admins and viewers see everything (viewers with cost fields removed, which is a
 * serialization concern, not a scope). Every repo method takes a Scope with no default, so a
 * query can't forget it.
 */
export type Scope = { readonly kind: 'all' } | { readonly kind: 'owner'; readonly email: string };

export function scopeFor(user: AuthUser): Scope {
  return user.role === 'owner' ? { kind: 'owner', email: user.email } : { kind: 'all' };
}

/**
 * A SQL predicate restricting `ownerColumn` to the scope. Appends the bound value to `params`
 * and refers to it by position, so the email is never interpolated into SQL.
 *
 *   const params: DuckDBValue[] = [];
 *   `... WHERE ${scopeSql(scope, 'o.current_owner', params)}`
 */
export function scopeSql(scope: Scope, ownerColumn: string, params: DuckDBValue[]): string {
  if (scope.kind === 'all') return 'TRUE';
  params.push(scope.email);
  return `${ownerColumn} = $${params.length}`;
}

/** The same rule for in-memory data (alerts). A NULL owner is visible only to unscoped users. */
export function scopeMatches(scope: Scope, ownerEmail: string | null): boolean {
  return scope.kind === 'all' || ownerEmail === scope.email;
}
