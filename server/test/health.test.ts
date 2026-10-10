import request from 'supertest';
import { config } from '../src/config.js';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('GET /health', () => {
  it('returns status, tick and uptime', async () => {
    const res = await request(createApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Number.isInteger(res.body.tick)).toBe(true);
    expect(res.body.tick).toBeGreaterThanOrEqual(0);
    expect(res.body.tick).toBeLessThan(config.SNAPSHOT_COUNT);
    expect(typeof res.body.uptime).toBe('number');
  });

  it('returns a JSON error for unknown API routes', async () => {
    const res = await request(createApp()).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(typeof res.body.error.message).toBe('string');
  });
});
