import nodemailer from 'nodemailer';
import { env } from './env.js';
import { logger } from './logger.js';

let transport;

/** Sends a plain-text email. `console` transport is for local development only. */
export async function sendMail({ to, subject, text }) {
  if (env.MAIL_TRANSPORT === 'smtp') {
    transport ??= nodemailer.createTransport(env.SMTP_URL);
    await transport.sendMail({ from: env.MAIL_FROM, to, subject, text });
    return;
  }
  if (env.MAIL_TRANSPORT === 'console') {
    // Development convenience only (blocked in production by env validation).
    logger.info({ subject }, `[mail:console] to=${to}\n${text}`);
    return;
  }
  logger.warn({ subject }, 'Mail transport is disabled (MAIL_TRANSPORT=none); email not sent');
}
