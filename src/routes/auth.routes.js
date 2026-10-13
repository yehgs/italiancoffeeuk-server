import { Router } from 'express';
import { env } from '../config/env.js';
import { validate } from '../middleware/validate.js';
import { loginLimiter, passwordResetLimiter, registerLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/authenticate.js';
import * as auth from '../services/authService.js';
import * as schemas from '../validators/schemas.js';
import { ok, created } from '../utils/respond.js';

const router = Router();

function setSessionCookie(res, session) {
  res.cookie(env.COOKIE_NAME, session.token, {
    httpOnly: true,
    secure: env.isProd || env.COOKIE_SAMESITE === 'none',
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN,
    expires: session.expiresAt,
    path: '/',
  });
}
const clearSessionCookie = (res) =>
  res.clearCookie(env.COOKIE_NAME, {
    httpOnly: true,
    secure: env.isProd || env.COOKIE_SAMESITE === 'none',
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN,
    path: '/',
  });

const sessionPayload = (type, subject, session) => ({
  type,
  user: type === 'admin' ? auth.publicAdmin(subject) : auth.publicUser(subject),
  csrfToken: session.csrfToken,
  expiresAt: session.expiresAt.toISOString(),
});

router.post('/register', registerLimiter, validate({ body: schemas.registerBody }), async (req, res) => {
  const user = await auth.registerCustomer(req.valid.body);
  const session = await auth.createSession('user', user.id, req);
  setSessionCookie(res, session);
  created(res, sessionPayload('user', user, session));
});

router.post('/login', loginLimiter, validate({ body: schemas.loginBody }), async (req, res) => {
  const user = await auth.verifyCustomer(req.valid.body.email, req.valid.body.password);
  const session = await auth.createSession('user', user.id, req);
  setSessionCookie(res, session);
  ok(res, sessionPayload('user', user, session));
});

router.post('/admin/login', loginLimiter, validate({ body: schemas.loginBody }), async (req, res) => {
  const admin = await auth.verifyAdmin(req.valid.body.email, req.valid.body.password);
  const session = await auth.createSession('admin', admin.id, req);
  setSessionCookie(res, session);
  ok(res, sessionPayload('admin', admin, session));
});

router.post('/logout', async (req, res) => {
  // Logging out never needs CSRF (worst case an attacker logs you out), and must always clear the cookie.
  if (req.auth) await auth.destroySession(req.auth.sessionId);
  clearSessionCookie(res);
  ok(res, { loggedOut: true });
});

router.get('/me', (req, res) => {
  if (!req.auth) return ok(res, null);
  const subject = req.auth.subject;
  ok(res, {
    type: req.auth.type,
    user: req.auth.type === 'admin' ? auth.publicAdmin(subject) : auth.publicUser(subject),
    csrfToken: req.auth.csrfToken,
  });
});

router.post('/forgot-password', passwordResetLimiter, validate({ body: schemas.forgotBody }), async (req, res) => {
  await auth.requestPasswordReset(req.valid.body.email);
  // identical response whether or not the account exists
  ok(res, { message: 'If an account exists for that email, a reset link has been sent.' }, undefined, 202);
});

router.post('/reset-password', passwordResetLimiter, validate({ body: schemas.resetBody }), async (req, res) => {
  await auth.resetPassword(req.valid.body.token, req.valid.body.newPassword);
  ok(res, { message: 'Password updated. Please sign in.' });
});

router.post('/change-password', requireAuth(), validate({ body: schemas.changePasswordBody }), async (req, res) => {
  const { currentPassword, newPassword } = req.valid.body;
  // admins have a stricter policy than customers
  (req.auth.type === 'admin' ? schemas.adminPassword : schemas.customerPassword).parse(newPassword);
  await auth.changePassword(req.auth, currentPassword, newPassword);
  ok(res, { message: 'Password changed' });
});

export default router;
