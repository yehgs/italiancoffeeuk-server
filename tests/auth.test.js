import { describe, expect, it } from 'vitest';
import { app, login, prisma, request, seedAdmin, seedCustomer } from './helpers/app.js';

const reg = {
  email: 'New.User@Example.com', password: 'Passw0rdOK', firstName: 'New', lastName: 'User',
  phone: '+234800000', address: '1 Main St, Abuja', zipCode: '900001',
};

describe('customer auth', () => {
  it('registers, sets an HttpOnly session cookie and never returns a hash', async () => {
    const res = await request(app).post('/api/auth/register').send(reg);
    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe('new.user@example.com');
    expect(res.body.data.user.displayName).toBe('New User');
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    const cookie = res.headers['set-cookie'].join(';');
    expect(cookie).toMatch(/ic_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('stores only a hash of the session token', async () => {
    const res = await request(app).post('/api/auth/register').send(reg);
    const raw = /ic_session=([^;]+)/.exec(res.headers['set-cookie'][0])[1];
    const rows = prisma.session.__rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toBe(raw);
    expect(rows[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects duplicate emails (case-insensitively) and weak passwords', async () => {
    await request(app).post('/api/auth/register').send(reg);
    const dup = await request(app).post('/api/auth/register').send({ ...reg, email: 'NEW.user@example.com' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_IN_USE');
    const weak = await request(app).post('/api/auth/register').send({ ...reg, email: 'a@b.co', password: 'short1' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');
    const noDigit = await request(app).post('/api/auth/register').send({ ...reg, email: 'c@d.co', password: 'onlyletters' });
    expect(noDigit.status).toBe(400);
  });

  it('logs in with a generic error for wrong password and unknown email', async () => {
    await seedCustomer();
    const wrong = await request(app).post('/api/auth/login').send({ email: 'jane@example.com', password: 'nope-nope1' });
    const unknown = await request(app).post('/api/auth/login').send({ email: 'ghost@example.com', password: 'nope-nope1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('refuses login for an imported account that has no password yet (must reset)', async () => {
    await prisma.user.create({ data: { email: 'old@example.com', passwordHash: null, firstName: 'Old', lastName: 'User' } });
    const res = await request(app).post('/api/auth/login').send({ email: 'old@example.com', password: 'Whatever123' });
    expect(res.status).toBe(401);
  });

  it('GET /me returns null when logged out and the user when logged in', async () => {
    const anon = await request(app).get('/api/auth/me');
    expect(anon.body.data).toBeNull();
    await seedCustomer();
    const s = await login('user', { email: 'jane@example.com', password: 'Passw0rdOK' });
    const me = await s.get('/api/auth/me');
    expect(me.body.data.user.email).toBe('jane@example.com');
    expect(me.body.data.user.uid).toBe(me.body.data.user.id);
  });

  it('logout destroys the server-side session', async () => {
    await seedCustomer();
    const s = await login('user', { email: 'jane@example.com', password: 'Passw0rdOK' });
    expect(prisma.session.__rows()).toHaveLength(1);
    await s.post('/api/auth/logout').send({});
    expect(prisma.session.__rows()).toHaveLength(0);
    const me = await s.get('/api/auth/me');
    expect(me.body.data).toBeNull();
  });
});

describe('admin auth + authorisation', () => {
  it('admin login works only on the admin endpoint and yields role-gated access', async () => {
    await seedAdmin();
    await seedCustomer();
    const asCustomer = await request(app).post('/api/auth/admin/login').send({ email: 'jane@example.com', password: 'Passw0rdOK' });
    expect(asCustomer.status).toBe(401);
    const s = await login('admin', { email: 'root@example.com', password: 'Sup3rSecretPass' });
    const list = await s.get('/api/admins');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|password"/);
  });

  it('customers cannot reach admin endpoints; anonymous gets 401', async () => {
    await seedCustomer();
    const anon = await request(app).get('/api/admins');
    expect(anon.status).toBe(401);
    const s = await login('user', { email: 'jane@example.com', password: 'Passw0rdOK' });
    expect((await s.get('/api/admins')).status).toBe(403);
    expect((await s.post('/api/manufacturers').send({ company: 'X' })).status).toBe(403);
  });

  it('plain admins cannot manage other admins (superadmin only)', async () => {
    await seedAdmin({ email: 'a@example.com', role: 'admin', password: 'Adm1nPassword1' });
    const s = await login('admin', { email: 'a@example.com', password: 'Adm1nPassword1' });
    expect((await s.get('/api/admins')).status).toBe(403);
  });

  it('requires the CSRF token on state-changing requests', async () => {
    await seedAdmin();
    const s = await login('admin', { email: 'root@example.com', password: 'Sup3rSecretPass' });
    const noToken = await s.agent.post('/api/tags').send({ tag: 'x' });
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.message).toMatch(/CSRF/);
    const wrong = await s.agent.post('/api/tags').set('X-CSRF-Token', 'wrong').send({ tag: 'x' });
    expect(wrong.status).toBe(403);
    expect((await s.post('/api/tags').send({ tag: 'x' })).status).toBe(201);
  });

  it('a disabled admin loses access immediately', async () => {
    const a = await seedAdmin();
    const s = await login('admin', { email: 'root@example.com', password: 'Sup3rSecretPass' });
    await prisma.admin.update({ where: { id: a.id }, data: { disabled: true } });
    expect((await s.get('/api/admins')).status).toBe(401);
  });
});

describe('admin management rules', () => {
  const body = { firstName: 'N', lastName: 'A', email: 'n@example.com', password: 'N3wAdminPass1', role: 'admin' };
  it('creates an admin with a hashed password, forcing a password change', async () => {
    await seedAdmin();
    const s = await login('admin', { email: 'root@example.com', password: 'Sup3rSecretPass' });
    const res = await s.post('/api/admins').send(body);
    expect(res.status).toBe(201);
    expect(res.body.data.mustChangePassword).toBe(true);
    const stored = prisma.admin.__rows().find((r) => r.email === 'n@example.com');
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(stored.password).toBeUndefined();
    expect((await s.post('/api/admins').send(body)).status).toBe(409);
  });
  it('enforces the stronger admin password policy', async () => {
    await seedAdmin();
    const s = await login('admin', { email: 'root@example.com', password: 'Sup3rSecretPass' });
    expect((await s.post('/api/admins').send({ ...body, password: 'abc123' })).status).toBe(400);
  });
  it('cannot delete yourself or the last super admin, and deleting kills sessions', async () => {
    const root = await seedAdmin();
    const s = await login('admin', { email: 'root@example.com', password: 'Sup3rSecretPass' });
    expect((await s.delete(`/api/admins/${root.id}`)).status).toBe(403);
    const other = await seedAdmin({ email: 'o@example.com', role: 'admin', password: 'Other1Password' });
    await login('admin', { email: 'o@example.com', password: 'Other1Password' });
    expect((await s.delete(`/api/admins/${other.id}`)).status).toBe(204);
    expect(prisma.session.__rows().filter((x) => x.subjectId === other.id)).toHaveLength(0);
  });
});

describe('password reset', () => {
  it('responds identically for known and unknown emails', async () => {
    await seedCustomer();
    const a = await request(app).post('/api/auth/forgot-password').send({ email: 'jane@example.com' });
    const b = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@example.com' });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.body).toEqual(b.body);
  });

  it('issues a single-use token that sets a new password and revokes sessions', async () => {
    const user = await seedCustomer();
    await login('user', { email: 'jane@example.com', password: 'Passw0rdOK' });
    // create a token the way requestPasswordReset does, then use it
    const { randomToken, sha256 } = await import('../src/utils/crypto.js');
    const token = randomToken(32);
    await prisma.passwordReset.create({ data: { tokenHash: sha256(token), subjectType: 'user', subjectId: user.id, expiresAt: new Date(Date.now() + 60_000) } });

    const ok = await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'Brand9NewPass' });
    expect(ok.status).toBe(200);
    expect(prisma.session.__rows()).toHaveLength(0);
    const reuse = await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'Another9Pass' });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('INVALID_RESET_TOKEN');
    const relog = await request(app).post('/api/auth/login').send({ email: 'jane@example.com', password: 'Brand9NewPass' });
    expect(relog.status).toBe(200);
  });

  it('rejects expired tokens', async () => {
    const user = await seedCustomer();
    const { randomToken, sha256 } = await import('../src/utils/crypto.js');
    const token = randomToken(32);
    await prisma.passwordReset.create({ data: { tokenHash: sha256(token), subjectType: 'user', subjectId: user.id, expiresAt: new Date(Date.now() - 1000) } });
    const res = await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'Brand9NewPass' });
    expect(res.status).toBe(400);
  });
});
