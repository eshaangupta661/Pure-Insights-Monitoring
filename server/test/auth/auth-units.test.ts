import jwt from 'jsonwebtoken';
import type { DuckDBValue } from '@duckdb/node-api';
import { describe, expect, it } from 'vitest';
import { signToken, verifyToken } from '../../src/auth/jwt.js';
import { scopeFor, scopeMatches, scopeSql } from '../../src/auth/scope.js';
import { findUser, verifyCredentials } from '../../src/auth/users.js';
import { config } from '../../src/config.js';

/** The public demo credentials from CLAUDE.md "Roles". */
const DEMO = [
  { email: 'admin@pureinsights.dev', password: 'Admin@123', role: 'admin' },
  { email: 'user_3@company.com', password: 'Owner@123', role: 'owner' },
  { email: 'viewer@pureinsights.dev', password: 'Viewer@123', role: 'viewer' },
] as const;

describe('seeded users', () => {
  it.each(DEMO)('$email signs in with the documented password as $role', async (d) => {
    expect(await verifyCredentials(d.email, d.password)).toEqual({ email: d.email, role: d.role });
  });

  it('rejects a wrong password and an unknown email', async () => {
    expect(await verifyCredentials('admin@pureinsights.dev', 'Owner@123')).toBeNull();
    expect(await verifyCredentials('nobody@pureinsights.dev', 'Admin@123')).toBeNull();
  });

  it('matches emails exactly (normalizing is the login schema’s job)', () => {
    expect(findUser('user_3@company.com')?.role).toBe('owner');
    expect(findUser('USER_3@company.com')).toBeUndefined();
  });
});

describe('jwt', () => {
  const owner = { email: 'user_3@company.com', role: 'owner' } as const;

  it('round-trips the user and reports expiry', () => {
    const before = Date.now();
    const { token, expiresAt } = signToken(owner);
    expect(verifyToken(token)).toEqual(owner);
    const ms = Date.parse(expiresAt) - before;
    expect(ms).toBeGreaterThan((config.JWT_EXPIRES_IN_SEC - 5) * 1000);
    expect(ms).toBeLessThanOrEqual(config.JWT_EXPIRES_IN_SEC * 1000 + 1000);
  });

  it('rejects expired, foreign-signed, unsigned and malformed tokens', () => {
    expect(verifyToken(signToken(owner, -10).token)).toBeNull();
    const foreign = jwt.sign({ role: 'admin' }, 'another-secret', { subject: owner.email });
    expect(verifyToken(foreign)).toBeNull();
    const unsigned = jwt.sign({ role: 'admin' }, '', { subject: owner.email, algorithm: 'none' });
    expect(verifyToken(unsigned)).toBeNull();
    expect(verifyToken('not-a-jwt')).toBeNull();
  });

  it('rejects a validly signed token whose claims are malformed', () => {
    const badRole = jwt.sign({ role: 'superuser' }, config.jwtSecret, { subject: owner.email });
    expect(verifyToken(badRole)).toBeNull();
  });
});

describe('scope', () => {
  it('owners are scoped to their email; admins and viewers see everything', () => {
    expect(scopeFor({ email: 'user_3@company.com', role: 'owner' })).toEqual({
      kind: 'owner',
      email: 'user_3@company.com',
    });
    expect(scopeFor({ email: 'admin@pureinsights.dev', role: 'admin' })).toEqual({ kind: 'all' });
    expect(scopeFor({ email: 'viewer@pureinsights.dev', role: 'viewer' })).toEqual({
      kind: 'all',
    });
  });

  it('builds a bound-parameter predicate, numbered after existing params', () => {
    const params: DuckDBValue[] = ['FAILED'];
    const sql = scopeSql({ kind: 'owner', email: "o'brien@x.com" }, 'o.current_owner', params);
    expect(sql).toBe('o.current_owner = $2');
    expect(params).toEqual(['FAILED', "o'brien@x.com"]);

    const none: DuckDBValue[] = [];
    expect(scopeSql({ kind: 'all' }, 'o.current_owner', none)).toBe('TRUE');
    expect(none).toEqual([]);
  });

  it('matches in-memory owners the same way; unowned rows only for unscoped users', () => {
    const owner = { kind: 'owner', email: 'user_3@company.com' } as const;
    expect(scopeMatches(owner, 'user_3@company.com')).toBe(true);
    expect(scopeMatches(owner, 'user_4@company.com')).toBe(false);
    expect(scopeMatches(owner, null)).toBe(false);
    expect(scopeMatches({ kind: 'all' }, null)).toBe(true);
  });
});
