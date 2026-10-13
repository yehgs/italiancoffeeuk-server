import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { env } from '../config/env.js';

const make = (opts) =>
  rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => env.NODE_ENV === 'test',
    handler: (_req, res) =>
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' } }),
    ...opts,
  });

export const globalLimiter = make({ windowMs: 60_000, limit: 300 });
export const loginLimiter = make({
  windowMs: 15 * 60_000,
  limit: 10,
  // limit per IP + email so one attacker cannot lock out everyone (or vice-versa)
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${String(req.body?.email ?? '').toLowerCase()}`,
  skipSuccessfulRequests: true,
});
export const registerLimiter = make({ windowMs: 60 * 60_000, limit: 20 });
export const passwordResetLimiter = make({ windowMs: 60 * 60_000, limit: 5 });
export const subscribeLimiter = make({ windowMs: 60 * 60_000, limit: 10 });
export const uploadSignLimiter = make({ windowMs: 10 * 60_000, limit: 60 });
