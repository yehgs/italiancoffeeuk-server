import { Resend } from 'resend';
import { env } from './env.js';
import { logger } from './logger.js';
import { MailError, describeMailError, recordSend } from './mailHealth.js';

let client;

/**
 * Sends an email through Resend (MAIL_TRANSPORT=resend). `console` is for local development
 * only and is blocked in production by env validation; `none` logs a warning and sends nothing.
 * Throws a MailError (with a plain-language `info`) if Resend rejects the message.
 */
export async function sendMail({ to, subject, text, html }) {
  if (env.MAIL_TRANSPORT === 'resend') {
    client ??= new Resend(env.RESEND_API_KEY);
    let data;
    let error;
    try {
      ({ data, error } = await client.emails.send({
        from: env.MAIL_FROM,
        to: [to],
        subject,
        text,
        ...(html ? { html } : {}),
        ...(env.MAIL_REPLY_TO ? { replyTo: env.MAIL_REPLY_TO } : {}),
      }));
    } catch (e) {
      error = { name: 'application_error', message: e?.message ?? String(e) };
    }
    if (error) {
      const info = describeMailError(error);
      logger.error(
        { subject, resend: { name: info.name, message: info.message, statusCode: info.statusCode }, fix: info.fix },
        `Resend rejected the email: ${info.title}`,
      );
      recordSend({ ok: false, subject, info });
      throw new MailError(info);
    }
    logger.info({ subject, id: data?.id }, 'email sent');
    recordSend({ ok: true, subject });
    return { id: data?.id };
  }
  if (env.MAIL_TRANSPORT === 'console') {
    logger.info({ subject }, `[mail:console] to=${to}\n${text}`);
    return {};
  }
  logger.warn({ subject }, 'Mail transport is disabled (MAIL_TRANSPORT=none); email not sent. Set MAIL_TRANSPORT=resend.');
  return { skipped: true };
}
