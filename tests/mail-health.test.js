import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
const list = vi.fn();
vi.mock('resend', () => ({ Resend: class { emails = { send }; domains = { list }; } }));

import { app, login, request, seedAdmin } from './helpers/app.js';
import { resetEnvCache } from '../src/config/env.js';
import { __resetMailHealthForTests, describeMailError, getMailReport } from '../src/config/mailHealth.js';

const use = (o) => { Object.assign(process.env, { MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_test_abcd', MAIL_FROM: 'Italian Coffee <no-reply@italiancoffee.co.uk>', ...o }); resetEnvCache(); __resetMailHealthForTests(); };
beforeEach(() => { send.mockReset(); list.mockReset(); });
afterEach(() => { process.env.MAIL_TRANSPORT = 'console'; delete process.env.RESEND_API_KEY; process.env.MAIL_FROM = 'Italian Coffee <no-reply@localhost>'; resetEnvCache(); __resetMailHealthForTests(); });

const levels = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c.level]));

describe('mail health report', () => {
  it('flags transport none as an error', async () => {
    use({ MAIL_TRANSPORT: 'none' });
    const r = await getMailReport();
    expect(r.ready).toBe(false);
    expect(levels(r).transport).toBe('error');
  });
  it('flags a placeholder sender domain', async () => {
    use({ MAIL_FROM: 'Italian Coffee <no-reply@example.com>' });
    list.mockResolvedValue({ data: { data: [] }, error: null });
    expect(levels(await getMailReport()).from).toBe('error');
  });
  it('is ready when Resend lists the sender domain as verified', async () => {
    use();
    list.mockResolvedValue({ data: { data: [{ name: 'italiancoffee.co.uk', status: 'verified' }] }, error: null });
    const r = await getMailReport();
    expect(r.ready).toBe(true);
    expect(levels(r).domain).toBe('ok');
  });
  it('names the real problem when the domain is in a different Resend team', async () => {
    use();
    list.mockResolvedValue({ data: { data: [{ name: 'yehgs.co.uk', status: 'verified' }] }, error: null });
    const r = await getMailReport();
    expect(r.ready).toBe(false);
    const d = r.checks.find((c) => c.id === 'domain');
    expect(d.title).toMatch(/italiancoffee\.co\.uk is not in the Resend team/);
    expect(d.detail).toMatch(/yehgs\.co\.uk/);
  });
  it('reports an unverified domain', async () => {
    use();
    list.mockResolvedValue({ data: { data: [{ name: 'italiancoffee.co.uk', status: 'pending' }] }, error: null });
    expect((await getMailReport()).checks.find((c) => c.id === 'domain').title).toMatch(/not verified \(status: pending\)/);
  });
  it('reports a rejected key', async () => {
    use();
    list.mockResolvedValue({ data: null, error: { name: 'invalid_api_key', message: 'API key is invalid', statusCode: 400 } });
    const r = await getMailReport();
    expect(r.ready).toBe(false);
    expect(levels(r).key).toBe('error');
  });
  it('treats a sending-only key as unverifiable, not broken', async () => {
    use();
    list.mockResolvedValue({ data: null, error: { name: 'restricted_api_key', message: 'This API key is restricted to only send emails', statusCode: 401 } });
    const r = await getMailReport();
    expect(r.ready).toBe(true);
    expect(levels(r).domain).toBe('warn');
  });
  it('translates Resend errors', () => {
    use();
    expect(describeMailError({ name: 'validation_error', message: 'The italiancoffee.co.uk domain is not verified.' }).code).toBe('DOMAIN_NOT_VERIFIED');
    expect(describeMailError({ name: 'rate_limit_exceeded', message: 'x', statusCode: 429 }).config).toBe(false);
  });
});

describe('forgot-password honesty', () => {
  it('answers 503 MAIL_UNAVAILABLE with the reasons when email cannot work', async () => {
    use({ MAIL_TRANSPORT: 'none' });
    await seedAdmin();
    for (const path of ['/api/auth/admin/forgot-password', '/api/auth/forgot-password']) {
      const r = await request(app).post(path).send({ email: 'root@example.com' });
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('MAIL_UNAVAILABLE');
      expect(r.body.error.details.problems[0].title).toMatch(/switched off/);
    }
  });
  it('gives the same 503 for an unknown email (no account enumeration)', async () => {
    use({ MAIL_TRANSPORT: 'none' });
    const r = await request(app).post('/api/auth/admin/forgot-password').send({ email: 'nobody@example.com' });
    expect(r.status).toBe(503);
  });
  it('blocks after a real send failure caused by configuration', async () => {
    use();
    list.mockResolvedValue({ data: null, error: { name: 'restricted_api_key', message: 'restricted', statusCode: 401 } });
    send.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'The italiancoffee.co.uk domain is not verified.', statusCode: 403 } });
    await seedAdmin();
    const first = await request(app).post('/api/auth/admin/forgot-password').send({ email: 'root@example.com' });
    expect(first.status).toBe(202);
    const second = await request(app).post('/api/auth/admin/forgot-password').send({ email: 'root@example.com' });
    expect(second.status).toBe(503);
    expect(second.body.error.details.problems[0].title).toMatch(/will not send from italiancoffee\.co\.uk/);
  });
});

describe('admin mail endpoints', () => {
  it('requires a super admin', async () => {
    expect((await request(app).get('/api/system/mail')).status).toBe(401);
  });
  it('returns the report and sends a real test message', async () => {
    use();
    list.mockResolvedValue({ data: { data: [{ name: 'italiancoffee.co.uk', status: 'verified' }] }, error: null });
    send.mockResolvedValue({ data: { id: 'em_9' }, error: null });
    await seedAdmin();
    const s = await login('admin', { email: 'root@example.com', password: 'Sup3rSecretPass' });
    expect((await s.get('/api/system/mail')).body.data.ready).toBe(true);
    const t = await s.post('/api/system/mail/test').send({});
    expect(t.status).toBe(200);
    expect(t.body.data).toMatchObject({ sent: true, to: 'root@example.com', id: 'em_9' });
    expect(send.mock.calls[0][0].to).toEqual(['root@example.com']);
  });
  it('returns Resend’s real error when the test send fails', async () => {
    use();
    list.mockResolvedValue({ data: { data: [] }, error: null });
    send.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'The italiancoffee.co.uk domain is not verified.', statusCode: 403 } });
    await seedAdmin();
    const s = await login('admin', { email: 'root@example.com', password: 'Sup3rSecretPass' });
    const t = await s.post('/api/system/mail/test').send({});
    expect(t.status).toBe(502);
    expect(t.body.error.code).toBe('MAIL_SEND_FAILED');
    expect(t.body.error.details).toMatchObject({ name: 'validation_error', code: 'DOMAIN_NOT_VERIFIED' });
  });
});
