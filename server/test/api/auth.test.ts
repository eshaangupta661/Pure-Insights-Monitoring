import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signToken } from '../../src/auth/jwt.js';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { DEMO_USERS, bearerFor, loginAs } from '../helpers/auth.js';

// Auth needs no warehouse, so these run against an app without deps.
const app = createApp();
const COOKIE = config.AUTH_COOKIE;

function sessionCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = raw?.find((c) => c.startsWith(`${COOKIE}=`));
  if (!cookie) throw new Error('no session cookie set');
  return cookie;
}

describe('POST /api/v1/auth/login', () => {
  it('sets an httpOnly, SameSite=Lax session cookie and returns {user, expiresAt}, no token', async () => {
    const res = await request(app).post('/api/v1/auth/login').send(DEMO_USERS.owner);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { email: 'user_3@company.com', role: 'owner' },
      expiresAt: expect.any(String),
    });
    expect(res.body).not.toHaveProperty('token');
    expect(JSON.stringify(res.body)).not.toMatch(/eyJ/); // no JWT anywhere in the body

    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/; HttpOnly/i);
    expect(cookie).toMatch(/; SameSite=Lax/i);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toMatch(new RegExp(`; Max-Age=${config.JWT_EXPIRES_IN_SEC}`));
    expect(cookie).not.toMatch(/; Secure/i); // Secure only in production (HTTPS)
  });

  it('accepts the email case- and whitespace-insensitively', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: '  USER_3@Company.COM ', password: 'Owner@123' });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('user_3@company.com');
  });

  it('wrong password and unknown email get the same 401 INVALID_CREDENTIALS', async () => {
    const wrong = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: DEMO_USERS.admin.email, password: 'nope' });
    const unknown = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@pureinsights.dev', password: 'Admin@123' });
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: { code: 'INVALID_CREDENTIALS', message: 'Wrong email or password' },
      });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('validates the body: 400 VALIDATION_ERROR naming the field', async () => {
    const noPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: DEMO_USERS.admin.email });
    expect(noPassword.status).toBe(400);
    expect(noPassword.body.error.code).toBe('VALIDATION_ERROR');
    expect(noPassword.body.error.message).toMatch(/^body\.password/);

    const badEmail = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: 'x' });
    expect(badEmail.status).toBe(400);
    expect(badEmail.body.error.message).toMatch(/^body\.email/);
  });
});

describe('session use', () => {
  it('the cookie authenticates GET /auth/me', async () => {
    const agent = await loginAs(app, 'viewer');
    const res = await agent.get('/api/v1/auth/me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: 'viewer@pureinsights.dev', role: 'viewer' });
  });

  it('a Bearer header works without the cookie (curl, Swagger), from Set-Cookie or signed', async () => {
    const login = await request(app).post('/api/v1/auth/login').send(DEMO_USERS.admin);
    const token = sessionCookie(login)
      .split(';')[0]!
      .slice(COOKIE.length + 1);
    const fromCookie = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(fromCookie.body).toEqual({ email: 'admin@pureinsights.dev', role: 'admin' });

    const signed = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearerFor('owner'));
    expect(signed.body).toEqual({ email: 'user_3@company.com', role: 'owner' });
  });

  it('401 UNAUTHENTICATED without credentials or with an invalid token', async () => {
    for (const auth of [undefined, 'Bearer garbage', 'Basic abc']) {
      const req = request(app).get('/api/v1/auth/me');
      const res = await (auth ? req.set('Authorization', auth) : req);
      expect(res.status, String(auth)).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
    const badCookie = await request(app).get('/api/v1/auth/me').set('Cookie', `${COOKIE}=garbage`);
    expect(badCookie.status).toBe(401);
  });

  it('a validly signed token claiming a role the account lacks is rejected', async () => {
    const forged = signToken({ email: 'user_3@company.com', role: 'admin' }).token;
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('logout clears the cookie; the agent is then signed out', async () => {
    const agent = await loginAs(app, 'owner');
    const out = await agent.post('/api/v1/auth/logout');
    expect(out.status).toBe(204);
    expect(sessionCookie(out)).toMatch(new RegExp(`^${COOKIE}=;.*Expires=Thu, 01 Jan 1970`));
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });
});

describe('Origin check on mutations (production mode)', () => {
  const prod = createApp(undefined, { enforceOrigin: true });
  const HOST = 'portal.example.com';

  it('rejects a POST from another origin with 403 BAD_ORIGIN', async () => {
    const res = await request(prod)
      .post('/api/v1/auth/login')
      .set('Host', HOST)
      .set('Origin', 'https://evil.example.net')
      .send(DEMO_USERS.admin);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BAD_ORIGIN');
  });

  it('rejects a malformed Origin', async () => {
    const res = await request(prod)
      .post('/api/v1/auth/login')
      .set('Host', HOST)
      .set('Origin', 'null')
      .send(DEMO_USERS.admin);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BAD_ORIGIN');
  });

  it('accepts a POST whose Origin matches the Host', async () => {
    const res = await request(prod)
      .post('/api/v1/auth/login')
      .set('Host', HOST)
      .set('Origin', `https://${HOST}`)
      .send(DEMO_USERS.admin);
    expect(res.status).toBe(200);
  });

  it('a cookie request without Origin is rejected; a bearer-only one passes (curl)', async () => {
    const token = signToken({ email: 'admin@pureinsights.dev', role: 'admin' }).token;
    const cookieOnly = await request(prod)
      .post('/api/v1/auth/logout')
      .set('Host', HOST)
      .set('Cookie', `${COOKIE}=${token}`);
    expect(cookieOnly.status).toBe(403);
    expect(cookieOnly.body.error.code).toBe('BAD_ORIGIN');

    const bearerOnly = await request(prod)
      .post('/api/v1/auth/logout')
      .set('Host', HOST)
      .set('Authorization', `Bearer ${token}`);
    expect(bearerOnly.status).toBe(204);
  });

  it('never blocks GET, whatever the Origin', async () => {
    const res = await request(prod)
      .get('/api/v1/auth/me')
      .set('Host', HOST)
      .set('Origin', 'https://evil.example.net')
      .set('Authorization', bearerFor('viewer'));
    expect(res.status).toBe(200);
  });

  it('is off outside production', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example.net')
      .send(DEMO_USERS.admin);
    expect(res.status).toBe(200);
  });
});

describe('login rate limit and proxy (security review L3)', () => {
  const HOST = 'portal.example.com';
  const limited = () => createApp(undefined, { loginRateLimit: { max: 3, windowMs: 60_000 } });
  const attempt = (app: ReturnType<typeof createApp>, ip?: string) => {
    const req = request(app).post('/api/v1/auth/login');
    return (ip ? req.set('X-Forwarded-For', ip) : req).send({
      email: DEMO_USERS.admin.email,
      password: 'wrong',
    });
  };

  it('allows max attempts per IP per window, then 429 RATE_LIMITED with Retry-After', async () => {
    const app = limited();
    for (let i = 0; i < 3; i++) expect((await attempt(app, '203.0.113.1')).status).toBe(401);
    const blocked = await attempt(app, '203.0.113.1');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // Correct credentials are blocked too while the window lasts.
    const valid = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '203.0.113.1')
      .send(DEMO_USERS.admin);
    expect(valid.status).toBe(429);
  });

  it('trust proxy: each client IP (from the proxy hop) has its own bucket', async () => {
    const app = limited();
    for (let i = 0; i < 4; i++) await attempt(app, '203.0.113.1');
    expect((await attempt(app, '203.0.113.2')).status).toBe(401);
  });

  it('a client cannot escape by prepending fake X-Forwarded-For entries', async () => {
    const app = limited();
    // Only the last hop (added by the proxy) is trusted; spoofed entries to its left are ignored.
    for (let i = 0; i < 3; i++) await attempt(app, `10.0.0.${i}, 203.0.113.9`);
    expect((await attempt(app, '10.9.9.9, 203.0.113.9')).status).toBe(429);
  });

  it('other routes are not limited', async () => {
    const app = limited();
    for (let i = 0; i < 5; i++) {
      expect(
        (await request(app).get('/api/v1/auth/me').set('Authorization', bearerFor('viewer')))
          .status,
      ).toBe(200);
    }
  });

  it('behind the proxy in production mode: Secure cookie and the Origin check still hold', async () => {
    const prod = createApp(undefined, { enforceOrigin: true, secureCookies: true });
    const viaProxy = (origin: string) =>
      request(prod)
        .post('/api/v1/auth/login')
        .set('Host', HOST) // Render passes the public Host through
        .set('X-Forwarded-Proto', 'https')
        .set('X-Forwarded-For', '198.51.100.7')
        .set('Origin', origin)
        .send(DEMO_USERS.admin);

    const ok = await viaProxy(`https://${HOST}`);
    expect(ok.status).toBe(200);
    expect(sessionCookie(ok)).toMatch(/; Secure/i);
    expect(sessionCookie(ok)).toMatch(/; HttpOnly/i);

    const evil = await viaProxy('https://evil.example.net');
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe('BAD_ORIGIN');

    // Secure doesn't depend on X-Forwarded-Proto reaching the app.
    const noProto = await request(prod)
      .post('/api/v1/auth/login')
      .set('Host', HOST)
      .set('Origin', `https://${HOST}`)
      .send(DEMO_USERS.admin);
    expect(sessionCookie(noProto)).toMatch(/; Secure/i);
  });
});
