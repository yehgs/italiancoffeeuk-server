import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
vi.mock('resend', () => ({ Resend: class { constructor(key) { this.key = key; } emails = { send }; } }));

import { sendMail } from '../src/config/mailer.js';
import { loadEnv, resetEnvCache } from '../src/config/env.js';
import { resetPasswordEmail } from '../src/utils/emailTemplates.js';

function useResend() {
  process.env.MAIL_TRANSPORT = 'resend';
  process.env.RESEND_API_KEY = 're_test_123';
  process.env.MAIL_FROM = 'Italian Coffee <no-reply@mail.example.test>';
  resetEnvCache();
}
beforeEach(() => { send.mockReset(); });
afterAll(() => { process.env.MAIL_TRANSPORT = 'none'; delete process.env.RESEND_API_KEY; resetEnvCache(); });

describe('Resend mailer', () => {
  it('sends through Resend with from/to/subject/text/html', async () => {
    useResend();
    send.mockResolvedValue({ data: { id: 'em_1' }, error: null });
    await sendMail({ to: 'a@b.co', subject: 'Hi', text: 't', html: '<p>t</p>' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      from: 'Italian Coffee <no-reply@mail.example.test>', to: ['a@b.co'], subject: 'Hi', text: 't', html: '<p>t</p>',
    }));
  });

  it('throws when Resend returns an error', async () => {
    useResend();
    send.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'domain not verified' } });
    await expect(sendMail({ to: 'a@b.co', subject: 'Hi', text: 't' })).rejects.toThrow(/validation_error/);
  });

  it('requires RESEND_API_KEY when the transport is resend', () => {
    expect(() => loadEnv({ DATABASE_URL: 'mongodb://x/y', MAIL_TRANSPORT: 'resend' })).toThrow(/RESEND_API_KEY/);
  });

  it('escapes user-controlled text in HTML emails', () => {
    const { html } = resetPasswordEmail({ firstName: '<img src=x onerror=1>', link: 'https://x.test/?a=1&b="2"' });
    expect(html).not.toContain('<img');
    expect(html).toContain('&amp;b=&quot;2&quot;');
  });
});
