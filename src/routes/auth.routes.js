import { assertMailDeliverable } from '../config/mailHealth.js';
import { Router } from 'express';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { isCrossSite } from '../utils/site.js';
import { validate } from '../middleware/validate.js';
import { loginIpLimiter, loginLimiter, passwordResetLimiter, registerLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/authenticate.js';
import * as auth from '../services/authService.js';
import * as schemas from '../validators/schemas.js';
import { ok, created } from '../utils/respond.js';

const router = Router();

let warnedCrossSite = false;
/** Cookie attributes for this request. In "auto" mode a cross-site website/API pair gets SameSite=None; Secure. */
function cookieAttrs(req) {
  const crossSite = isCrossSite(req.get('origin'), req.hostname);
  let sameSite = env.COOKIE_SAMESITE;
  if (sameSite === 'auto') sameSite = crossSite ? 'none' : 'lax';
  if (crossSite && sameSite === 'none' && !warnedCrossSite) {
    warnedCrossSite = true;
    logger.warn(
      { origin: req.get('origin'), apiHost: req.hostname },
      'AUTH: the website and the API are on different sites, so the session cookie is a third-party cookie. Safari, Firefox strict mode and private windows may block it and sign-in will fail there. Fix: serve the API from a subdomain of the website (e.g. api.italiancoffee.co.uk) and set COOKIE_DOMAIN=.italiancoffee.co.uk.',
    );
  }
  if (crossSite && (sameSite === 'lax' || sameSite === 'strict')) {
    logger.error(
      { origin: req.get('origin'), apiHost: req.hostname, sameSite },
      'AUTH: COOKIE_SAMESITE is lax/strict but the website and API are on different sites. Browsers will discard the session cookie, so every request after login fails with "Authentication required". Set COOKIE_SAMESITE=auto (or none).',
    );
  }
  return { httpOnly: true, secure: env.isProd || sameSite === 'none', sameSite, domain: env.COOKIE_DOMAIN, path: '/' };
}
function setSessionCookie(req, res, session) {
  res.cookie(env.COOKIE_NAME, session.token, { ...cookieAttrs(req), expires: session.expiresAt });
}
const clearSessionCookie = (req, res) => res.clearCookie(env.COOKIE_NAME, cookieAttrs(req));

const sessionPayload = (type, subject, session) => ({
  type,
  user: type === 'admin' ? auth.publicAdmin(subject) : auth.publicUser(subject),
  csrfToken: session.csrfToken,
  expiresAt: session.expiresAt.toISOString(),
});

router.post('/register', registerLimiter, validate({ body: schemas.registerBody }), async (req, res) => {
  const user = await auth.registerCustomer(req.valid.body);
  const session = await auth.createSession('user', user.id, req);
  setSessionCookie(req, res, session);
  created(res, sessionPayload('user', user, session));
});

router.post('/login', loginIpLimiter, loginLimiter, validate({ body: schemas.loginBody }), async (req, res) => {
  const user = await auth.verifyCustomer(req.valid.body.email, req.valid.body.password);
  if (req.auth) await auth.destroySession(req.auth.sessionId); // never reuse an old session
  const session = await auth.createSession('user', user.id, req);
  setSessionCookie(req, res, session);
  ok(res, sessionPayload('user', user, session));
});

router.post('/admin/login', loginIpLimiter, loginLimiter, validate({ body: schemas.loginBody }), async (req, res) => {
  const admin = await auth.verifyAdmin(req.valid.body.email, req.valid.body.password);
  if (req.auth) await auth.destroySession(req.auth.sessionId);
  const session = await auth.createSession('admin', admin.id, req);
  setSessionCookie(req, res, session);
  ok(res, sessionPayload('admin', admin, session));
});

router.post('/logout', async (req, res) => {
  // Logging out never needs CSRF (worst case an attacker logs you out), and must always clear the cookie.
  if (req.auth) await auth.destroySession(req.auth.sessionId);
  clearSessionCookie(req, res);
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
  await assertMailDeliverable();
  await auth.requestPasswordReset(req.valid.body.email);
  // identical response whether or not the account exists
  ok(res, { message: 'If an account exists for that email, a reset link has been sent.' }, undefined, 202);
});

router.post('/reset-password', passwordResetLimiter, validate({ body: schemas.resetBody }), async (req, res) => {
  await auth.resetPassword(req.valid.body.token, req.valid.body.newPassword);
  ok(res, { message: 'Password updated. Please sign in.' });
});

router.post('/admin/forgot-password', passwordResetLimiter, validate({ body: schemas.forgotBody }), async (req, res) => {
  await assertMailDeliverable();
  await auth.requestPasswordReset(req.valid.body.email, 'admin');
  // identical response whether or not an admin account exists for that email
  ok(res, { message: 'If an admin account exists for that email, a reset link has been sent.' }, undefined, 202);
});

router.post('/admin/reset-password', passwordResetLimiter, validate({ body: schemas.adminResetBody }), async (req, res) => {
  await auth.resetPassword(req.valid.body.token, req.valid.body.newPassword, 'admin');
  ok(res, { message: 'Password updated. Please sign in.' });
});

// allowForced: an admin who must change their password may call this (and only this) before doing so
router.post('/change-password', requireAuth({ allowForced: true }), validate({ body: schemas.changePasswordBody }), async (req, res) => {
  const { currentPassword, newPassword } = req.valid.body;
  // admins have a stricter policy than customers
  (req.auth.type === 'admin' ? schemas.adminPassword : schemas.customerPassword).parse(newPassword);
  await auth.changePassword(req.auth, currentPassword, newPassword);
  ok(res, { message: 'Password changed' });
});

export default router;
