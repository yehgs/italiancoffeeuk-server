import pino from 'pino';
import { env } from './env.js';

// Never log credentials, tokens, cookies or personal data.
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-csrf-token"]',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.newPassword',
      '*.currentPassword',
      '*.token',
      '*.email',
    ],
    censor: '[redacted]',
  },
  ...(env.isProd ? {} : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
});
