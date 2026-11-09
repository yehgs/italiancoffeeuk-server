import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, login, prisma, request, seedAdmin, seedCustomer } from './helpers/app.js';
import { resetEnvCache, loadEnv } from '../src/config/env.js';
import { siteOf, isCrossSite } from '../src/utils/site.js';
import { purgeExpired } from '../src/services/authService.js';

const cookieOf = (res) => (res.headers['set-cookie'] ?? []).find((c) => c.startsWith('ic_session='));
const adminLogin = (headers = {}) => {
  let r = request(app).post('/api/auth/admin/login');
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send({ email: 'root@example.com', password: 'Sup3rSecretPass' });
};

describe('site detection', () => {
  it('compares registrable domains', () => {
    expect(siteOf('api.italiancoffee.co.uk')).toBe('italiancoffee.co.uk');
    expect(isCrossSite('https://italiancoffee.co.uk', 'api.italiancoffee.co.uk')).toBe(false);
    expect(isCrossSite('https://www.italiancoffee.co.uk', 'api.italiancoffee.co.uk')).toBe(false);
    expect(isCrossSite('https://italiancoffee.pages.dev', 'italiancoffee-api-1234.europe-west2.run.app')).toBe(true);
    expect(isCrossSite('https://italiancoffee.co.uk', 'italiancoffee-api-1234.run.app')).toBe(true);
    expect(isCrossSite('http://localhost:3000', 'localhost:4000')).toBe(false);
    expect(isCrossSite(undefined, 'x.run.app')).toBe(false);
  });
});

describe('session cookie attributes', () => {
  beforeAll(() => { process.env.CORS_ORIGINS = 'http://localhost:3000,https://italiancoffee.co.uk'; resetEnvCache(); });
  afterAll(() => { process.env.CORS_ORIGINS = 'http://localhost:3000'; resetEnvCache(); });
  it('uses SameSite=None; Secure when the website and API are on different sites (auto)', async () => {
    await seedAdmin();
    const res = await adminLogin({ Origin: 'https://italiancoffee.co.uk', Host: 'italiancoffee-api-1234.run.app' });
    expect(res.status).toBe(200);
    expect(cookieOf(res)).toMatch(/SameSite=None/i);
    expect(cookieOf(res)).toMatch(/Secure/i);
    expect(cookieOf(res)).toMatch(/HttpOnly/i);
  });
  it('keeps SameSite=Lax when both are on the same site', async () => {
    await seedAdmin();
    const res = await adminLogin({ Origin: 'https://italiancoffee.co.uk', Host: 'api.italiancoffee.co.uk' });
    expect(cookieOf(res)).toMatch(/SameSite=Lax/i);
  });
  it('honours an explicit COOKIE_SAMESITE', async () => {
    process.env.COOKIE_SAMESITE = 'strict'; resetEnvCache();
    try {
      await seedAdmin();
      expect(cookieOf(await adminLogin({ Origin: 'http://localhost:3000', Host: 'localhost:4000' }))).toMatch(/SameSite=Strict/i);
    } finally { delete process.env.COOKIE_SAMESITE; resetEnvCache(); }
  });
  it('defaults: auto cookies, and one proxy hop in production', () => {
    const base = { DATABASE_URL: 'mongodb://x/y' };
    expect(loadEnv(base).COOKIE_SAMESITE).toBe('auto');
    expect(loadEnv(base).TRUST_PROXY).toBe(0);
    expect(loadEnv({ ...base, NODE_ENV: 'production' }).TRUST_PROXY).toBe(1);
    expect(loadEnv({ ...base, NODE_ENV: 'production', TRUST_PROXY: '2' }).TRUST_PROXY).toBe(2);
  });
});

describe('error codes never confuse a wrong password with a missing session', () => {
  it('no session → 401 UNAUTHENTICATED; bad login → 401 INVALID_CREDENTIALS; wrong current password → 400', async () => {
    const anon = await request(app).post('/api/auth/change-password').send({ currentPassword: 'a', newPassword: 'Another1Pass' });
    expect(anon.status).toBe(401);
    expect(anon.body.error.code).toBe('UNAUTHENTICATED');
    await seedCustomer();
    const bad = await request(app).post('/api/auth/login').send({ email: 'jane@example.com', password: 'wrong-pass1' });
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
    const s = await login('user', { email: 'jane@example.com', password: 'Passw0rdOK' });
    const wrong = await s.post('/api/auth/change-password').send({ currentPassword: 'wrong-pass1', newPassword: 'Another1Pass' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('WRONG_CURRENT_PASSWORD');
  });
  it('rejects reusing the current password', async () => {
    await seedCustomer();
    const s = await login('user', { email: 'jane@example.com', password: 'Passw0rdOK' });
    const same = await s.post('/api/auth/change-password').send({ currentPassword: 'Passw0rdOK', newPassword: 'Passw0rdOK' });
    expect(same.status).toBe(400);
    expect(same.body.error.code).toBe('PASSWORD_UNCHANGED');
  });
});

describe('forced password change is enforced by the server', () => {
  it('blocks every admin API except /me, logout and change-password until the password is changed', async () => {
    const a = await seedAdmin();
    await prisma.admin.update({ where: { id: a.id }, data: { mustChangePassword: true } });
    const s = await login('admin', { email: 'root@example.com', password: 'Sup3rSecretPass' });
    const blocked = await s.get('/api/admins');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await s.post('/api/system/mail/test').send({})).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await s.get('/api/auth/me')).body.data.user.mustChangePassword).toBe(true);
    expect((await s.post('/api/auth/change-password').send({ currentPassword: 'Sup3rSecretPass', newPassword: 'Brand9NewAdminPw' })).status).toBe(200);
    expect((await s.get('/api/admins')).status).toBe(200);
  });
});

describe('sessions', () => {
  it('logging in again replaces the previous session of that browser', async () => {
    await seedAdmin();
    const agent = request.agent(app);
    await agent.post('/api/auth/admin/login').send({ email: 'root@example.com', password: 'Sup3rSecretPass' });
    expect(await prisma.session.count({})).toBe(1);
    await agent.post('/api/auth/admin/login').send({ email: 'root@example.com', password: 'Sup3rSecretPass' });
    expect(await prisma.session.count({})).toBe(1);
  });
  it('purges expired sessions and old reset tokens only', async () => {
    const a = await seedAdmin();
    const day = 24 * 3600_000;
    await prisma.session.create({ data: { tokenHash: 'old', csrfToken: 'c', subjectType: 'admin', subjectId: a.id, expiresAt: new Date(Date.now() - 1000) } });
    await prisma.session.create({ data: { tokenHash: 'live', csrfToken: 'c', subjectType: 'admin', subjectId: a.id, expiresAt: new Date(Date.now() + day) } });
    await prisma.passwordReset.create({ data: { tokenHash: 'r1', subjectType: 'admin', subjectId: a.id, expiresAt: new Date(Date.now() - 3 * day) } });
    await prisma.passwordReset.create({ data: { tokenHash: 'r2', subjectType: 'admin', subjectId: a.id, expiresAt: new Date(Date.now() + 1000) } });
    expect(await purgeExpired()).toEqual({ sessions: 1, resets: 1 });
    expect(await prisma.session.count({})).toBe(1);
    expect(await prisma.passwordReset.count({})).toBe(1);
  });
});
