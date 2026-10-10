import { describe, expect, it } from 'vitest';
import { JWT_SECRET_MIN_LENGTH, config, envSchema, resolveJwtSecret } from '../src/config.js';

const LONG = 'x'.repeat(JWT_SECRET_MIN_LENGTH);

describe('JWT secret (security review M3, L5)', () => {
  it('production requires JWT_SECRET', () => {
    const r = envSchema.safeParse({ NODE_ENV: 'production' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/required when NODE_ENV=production/);
  });

  it(`JWT_SECRET must be at least ${JWT_SECRET_MIN_LENGTH} characters`, () => {
    for (const NODE_ENV of ['production', 'development'] as const) {
      const short = envSchema.safeParse({ NODE_ENV, JWT_SECRET: 'x'.repeat(31) });
      expect(short.success, NODE_ENV).toBe(false);
      expect(short.error?.issues[0]?.message).toMatch(/at least 32 characters/);
      expect(envSchema.safeParse({ NODE_ENV, JWT_SECRET: LONG }).success, NODE_ENV).toBe(true);
    }
  });

  it('an explicit JWT_SECRET is always used', () => {
    expect(resolveJwtSecret({ NODE_ENV: 'development', JWT_SECRET: LONG })).toEqual({
      secret: LONG,
      source: 'env',
    });
  });

  it('without JWT_SECRET outside tests, each process gets a fresh random key (no published fallback)', () => {
    const a = resolveJwtSecret({ NODE_ENV: 'development', JWT_SECRET: undefined });
    const b = resolveJwtSecret({ NODE_ENV: 'development', JWT_SECRET: undefined });
    expect(a.source).toBe('random-per-process');
    expect(a.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(a.secret).not.toBe(b.secret);
  });

  it('only NODE_ENV=test gets the fixed key, and that is what the test run uses', () => {
    expect(resolveJwtSecret({ NODE_ENV: 'test', JWT_SECRET: undefined }).source).toBe('test-fixed');
    expect(config.nodeEnv).toBe('test');
  });
});
