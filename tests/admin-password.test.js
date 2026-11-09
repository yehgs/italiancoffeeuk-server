import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app, login, prisma, request, seedAdmin, seedCustomer } from './helpers/app.js';

const sent = [];
let failMail = false;
vi.mock('../src/config/mailer.js', () => ({
  sendMail: async (m) => { if (failMail) throw new Error('provider down'); sent.push(m); },
}));
beforeEach(() => { sent.length = 0; failMail = false; });

const tokenFrom = (mail) => new URL(/https?:\/\/\S+/.exec(mail.text)[0]).searchParams.get('token');

describe('forced password change (bootstrap / imported / created admins)', () => {
  it('logs in, reports mustChangePassword, and clears it after a valid change', async () => {
    const a = await seedAdmin();
    await prisma.admin.update({ where: { id: a.id }, data: { mustChangePassword: true } });
    const r = await request(app).post('/api/auth/admin/login').send({ email: 'root@example.com', password: 'Sup3rSecretPass' });
    expect(r.status).toBe(200);
    expect(r.body.data.user.mustChangePassword).toBe(true);

    const s = await login('admin', { email: 'root@example.com', password: 'Sup3rSecretPass' });
    const weak = await s.post('/api/auth/change-password').send({ currentPassword: 'Sup3rSecretPass', newPassword: 'short1' });
    expect(weak.status).toBe(400);
    const wrong = await s.post('/api/auth/change-password').send({ currentPassword: 'nope', newPassword: 'Brand9NewAdminPw' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('WRONG_CURRENT_PASSWORD');
    const ok = await s.post('/api/auth/change-password').send({ currentPassword: 'Sup3rSecretPass', newPassword: 'Brand9NewAdminPw' });
    expect(ok.status).toBe(200);

    const me = await s.get('/api/auth/me');
    expect(me.body.data.user.mustChangePassword).toBe(false);
    expect((await request(app).post('/api/auth/admin/login').send({ email: 'root@example.com', password: 'Sup3rSecretPass' })).status).toBe(401);
    const again = await request(app).post('/api/auth/admin/login').send({ email: 'root@example.com', password: 'Brand9NewAdminPw' });
    expect(again.body.data.user.mustChangePassword).toBe(false);
  });
});

describe('admin forgot / reset password', () => {
  it('answers identically for an admin, an unknown email and a customer email', async () => {
    await seedAdmin();
    await seedCustomer();
    const bodies = [];
    for (const email of ['root@example.com', 'nobody@example.com', 'jane@example.com']) {
      const r = await request(app).post('/api/auth/admin/forgot-password').send({ email });
      expect(r.status).toBe(202);
      bodies.push(r.body);
    }
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
    // only the real admin got an email, and it points at the admin reset page
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('root@example.com');
    expect(sent[0].text).toContain('/admin-reset-password?token=');
    expect(sent[0].subject).toMatch(/admin/i);
  });

  it('resets the password, clears the forced-change flag, revokes sessions and is single-use', async () => {
    const a = await seedAdmin();
    await prisma.admin.update({ where: { id: a.id }, data: { mustChangePassword: true } });
    await login('admin', { email: 'root@example.com', password: 'Sup3rSecretPass' });
    await request(app).post('/api/auth/admin/forgot-password').send({ email: 'Root@Example.com' });
    const token = tokenFrom(sent[0]);

    const weak = await request(app).post('/api/auth/admin/reset-password').send({ token, newPassword: 'short1' });
    expect(weak.status).toBe(400); // the admin policy (10+ characters) applies
    const ok = await request(app).post('/api/auth/admin/reset-password').send({ token, newPassword: 'Fresh9AdminPass' });
    expect(ok.status).toBe(200);
    expect(prisma.session.__rows()).toHaveLength(0);
    expect(sent.at(-1).subject).toMatch(/changed/i); // security notice

    const reuse = await request(app).post('/api/auth/admin/reset-password').send({ token, newPassword: 'Other9AdminPass' });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('INVALID_RESET_TOKEN');

    const relog = await request(app).post('/api/auth/admin/login').send({ email: 'root@example.com', password: 'Fresh9AdminPass' });
    expect(relog.status).toBe(200);
    expect(relog.body.data.user.mustChangePassword).toBe(false);
  });

  it('only the newest link works', async () => {
    await seedAdmin();
    await request(app).post('/api/auth/admin/forgot-password').send({ email: 'root@example.com' });
    await request(app).post('/api/auth/admin/forgot-password').send({ email: 'root@example.com' });
    const [first, second] = sent.map(tokenFrom);
    expect((await request(app).post('/api/auth/admin/reset-password').send({ token: first, newPassword: 'Fresh9AdminPass' })).status).toBe(400);
    expect((await request(app).post('/api/auth/admin/reset-password').send({ token: second, newPassword: 'Fresh9AdminPass' })).status).toBe(200);
  });

  it('a customer link cannot reset an admin and an admin link cannot reset a customer', async () => {
    await seedAdmin();
    await seedCustomer();
    await request(app).post('/api/auth/forgot-password').send({ email: 'jane@example.com' });
    await request(app).post('/api/auth/admin/forgot-password').send({ email: 'root@example.com' });
    const [customerToken, adminToken] = sent.map(tokenFrom);
    const a = await request(app).post('/api/auth/admin/reset-password').send({ token: customerToken, newPassword: 'Fresh9AdminPass' });
    const b = await request(app).post('/api/auth/reset-password').send({ token: adminToken, newPassword: 'Fresh9CustPass' });
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
    expect(a.body.error.code).toBe('INVALID_RESET_TOKEN');
    // and both real tokens still work on their own endpoint
    expect((await request(app).post('/api/auth/admin/reset-password').send({ token: adminToken, newPassword: 'Fresh9AdminPass' })).status).toBe(200);
    expect((await request(app).post('/api/auth/reset-password').send({ token: customerToken, newPassword: 'Fresh9CustPass' })).status).toBe(200);
  });

  it('a disabled admin gets no email, and a link issued earlier stops working', async () => {
    const a = await seedAdmin();
    await request(app).post('/api/auth/admin/forgot-password').send({ email: 'root@example.com' });
    const token = tokenFrom(sent[0]);
    await prisma.admin.update({ where: { id: a.id }, data: { disabled: true } });
    expect((await request(app).post('/api/auth/admin/reset-password').send({ token, newPassword: 'Fresh9AdminPass' })).status).toBe(400);
    sent.length = 0;
    await request(app).post('/api/auth/admin/forgot-password').send({ email: 'root@example.com' });
    expect(sent).toHaveLength(0);
  });

  it('still answers 202 (same body) when the email provider fails', async () => {
    await seedAdmin();
    const ok = await request(app).post('/api/auth/admin/forgot-password').send({ email: 'root@example.com' });
    failMail = true;
    const failed = await request(app).post('/api/auth/admin/forgot-password').send({ email: 'root@example.com' });
    expect(failed.status).toBe(202);
    expect(failed.body).toEqual(ok.body);
  });

  it('rejects an invalid email address', async () => {
    expect((await request(app).post('/api/auth/admin/forgot-password').send({ email: 'nope' })).status).toBe(400);
  });
});
