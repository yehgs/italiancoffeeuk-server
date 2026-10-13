import { Resend } from 'resend';
import { env } from './env.js';
import { logger } from './logger.js';

let client;

/**
 * Sends an email through Resend (MAIL_TRANSPORT=resend). `console` is for local development
 * only and is blocked in production by env validation; `none` logs a warning and sends nothing.
 * Throws if Resend rejects the message so callers/logs can see it.
 */
export async function sendMail({ to, subject, text, html }) {
  if (env.MAIL_TRANSPORT === 'resend') {
    client ??= new Resend(env.RESEND_API_KEY);
    const { data, error } = await client.emails.send({
      from: env.MAIL_FROM,
      to: [to],
      subject,
      text,
      ...(html ? { html } : {}),
      ...(env.MAIL_REPLY_TO ? { replyTo: env.MAIL_REPLY_TO } : {}),
    });
    if (error) {
      logger.error({ subject, resend: { name: error.name, message: error.message } }, 'Resend rejected the email');
      throw new Error(`Email could not be sent (${error.name ?? 'resend_error'})`);
    }
    logger.info({ subject, id: data?.id }, 'email sent');
    return;
  }
  if (env.MAIL_TRANSPORT === 'console') {
    logger.info({ subject }, `[mail:console] to=${to}\n${text}`);
    return;
  }
  logger.warn({ subject }, 'Mail transport is disabled (MAIL_TRANSPORT=none); email not sent');
}
