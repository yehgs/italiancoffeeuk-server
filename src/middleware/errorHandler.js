import { ZodError } from 'zod';
import { HttpError } from '../utils/httpError.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';

export function notFoundHandler(_req, _res, next) {
  next(new HttpError(404, 'NOT_FOUND', 'Route not found'));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
  }
  // body-parser errors (malformed JSON / payload too large)
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
  }
  // CORS rejection from our origin check
  if (err?.code === 'CORS_ORIGIN_DENIED') {
    return res.status(403).json({ error: { code: 'CORS_ORIGIN_DENIED', message: 'Origin not allowed' } });
  }
  // Prisma "unique constraint failed" (MongoDB: P2002)
  if (err?.code === 'P2002') {
    return res.status(409).json({ error: { code: 'DUPLICATE', message: 'A record with that value already exists' } });
  }
  logger.error({ err: { name: err?.name, message: err?.message, stack: env.isProd ? undefined : err?.stack }, url: req.originalUrl, method: req.method }, 'unhandled error');
  // Never leak internals or stack traces to clients.
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
}
