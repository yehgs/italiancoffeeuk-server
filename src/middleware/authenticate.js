import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { sha256, safeEqual } from '../utils/crypto.js';
import { forbidden, unauthorized } from '../utils/httpError.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Resolves the session cookie to req.auth = { sessionId, type, id, role, csrfToken, subject }.
 * Never throws for a missing/expired cookie: routes opt-in with requireAuth().
 */
export async function loadSession(req, _res, next) {
  const raw = req.cookies?.[env.COOKIE_NAME];
  if (!raw) return next();
  const session = await prisma.session.findUnique({ where: { tokenHash: sha256(raw) } });
  if (!session || session.expiresAt <= new Date()) return next();

  const subject =
    session.subjectType === 'admin'
      ? await prisma.admin.findUnique({ where: { id: session.subjectId } })
      : await prisma.user.findUnique({ where: { id: session.subjectId } });
  if (!subject || subject.disabled) return next();

  req.auth = {
    sessionId: session.id,
    type: session.subjectType,
    id: subject.id,
    role: session.subjectType === 'admin' ? subject.role : 'customer',
    csrfToken: session.csrfToken,
    subject,
  };
  next();
}

/** Requires a valid session of one of the given types/roles, and a CSRF token on unsafe methods. */
export const requireAuth =
  ({ type, roles } = {}) =>
  (req, _res, next) => {
    if (!req.auth) return next(unauthorized());
    if (type && req.auth.type !== type) return next(forbidden());
    if (roles && !roles.includes(req.auth.role)) return next(forbidden());
    if (!SAFE_METHODS.has(req.method)) {
      const sent = req.get('x-csrf-token');
      if (!sent || !safeEqual(sent, req.auth.csrfToken)) {
        return next(forbidden('Missing or invalid CSRF token'));
      }
    }
    next();
  };

export const requireCustomer = requireAuth({ type: 'user' });
export const requireAdmin = requireAuth({ type: 'admin', roles: ['admin', 'superadmin'] });
export const requireSuperAdmin = requireAuth({ type: 'admin', roles: ['superadmin'] });
