import bcrypt from 'bcryptjs';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { sendMail } from '../config/mailer.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import { normalizeEmail } from '../utils/ids.js';
import { passwordChangedEmail, resetPasswordEmail } from '../utils/emailTemplates.js';
import { logger } from '../config/logger.js';
import { HttpError, conflict, unauthorized } from '../utils/httpError.js';

const hashPassword = (plain) => bcrypt.hash(plain, env.BCRYPT_ROUNDS);
// Compared when the account does not exist so response time doesn't reveal it.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export { hashPassword };

export const INVALID_LOGIN = 'Invalid email or password';

export function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    displayName: `${u.firstName} ${u.lastName}`.trim(),
    phone: u.phone ?? '',
    address: u.address ?? '',
    zipCode: u.zipCode ?? '',
    role: 'customer',
    // `uid` kept so existing components that read user.uid keep working
    uid: u.id,
  };
}

export function publicAdmin(a) {
  return {
    id: a.id,
    email: a.email,
    firstName: a.firstName,
    lastName: a.lastName,
    role: a.role,
    mustChangePassword: Boolean(a.mustChangePassword),
    disabled: Boolean(a.disabled),
    createdAt: a.createdAt instanceof Date ? a.createdAt.toISOString() : a.createdAt,
  };
}

export async function createSession(type, subjectId, req) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const hours = type === 'admin' ? env.ADMIN_SESSION_HOURS : env.CUSTOMER_SESSION_HOURS;
  const expiresAt = new Date(Date.now() + hours * 3600_000);
  await prisma.session.create({
    data: {
      tokenHash: sha256(token),
      csrfToken,
      subjectType: type,
      subjectId,
      userAgent: String(req?.get?.('user-agent') ?? '').slice(0, 200) || null,
      ip: req?.ip ?? null,
      expiresAt,
    },
  });
  return { token, csrfToken, expiresAt };
}

export async function destroySession(sessionId) {
  await prisma.session.deleteMany({ where: { id: sessionId } });
}
export async function destroyAllSessions(type, subjectId) {
  await prisma.session.deleteMany({ where: { subjectType: type, subjectId } });
}

// ───────────────────────── customers ─────────────────────────

export async function registerCustomer(input) {
  const email = normalizeEmail(input.email);
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw conflict('An account with this email already exists', 'EMAIL_IN_USE');
  try {
    return await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(input.password),
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        address: input.address,
        zipCode: input.zipCode,
        deliveryAddress: input.deliveryAddress ?? false,
      },
    });
  } catch (e) {
    if (e?.code === 'P2002') throw conflict('An account with this email already exists', 'EMAIL_IN_USE');
    throw e;
  }
}

export async function verifyCustomer(emailInput, password) {
  const user = await prisma.user.findUnique({ where: { email: normalizeEmail(emailInput) } });
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.passwordHash || !ok || user.disabled) throw unauthorized(INVALID_LOGIN);
  return user;
}

export async function verifyAdmin(emailInput, password) {
  const admin = await prisma.admin.findUnique({ where: { email: normalizeEmail(emailInput) } });
  const ok = await bcrypt.compare(password, admin?.passwordHash ?? DUMMY_HASH);
  if (!admin || !ok || admin.disabled) throw unauthorized(INVALID_LOGIN);
  return admin;
}

// ───────────────────────── password reset ─────────────────────────

const RESET_TTL_MS = 60 * 60 * 1000;

/** Always resolves, whether or not the account exists (no enumeration). */
export async function requestPasswordReset(emailInput) {
  const user = await prisma.user.findUnique({ where: { email: normalizeEmail(emailInput) } });
  if (!user || user.disabled) return;
  const token = randomToken(32);
  await prisma.passwordReset.create({
    data: {
      tokenHash: sha256(token),
      subjectType: 'user',
      subjectId: user.id,
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
    },
  });
  const link = `${env.FRONTEND_URL.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
  // A mail failure must not change the response, or it would reveal that the account exists.
  try {
    await sendMail({ to: user.email, ...resetPasswordEmail({ firstName: user.firstName, link }) });
  } catch (err) {
    logger.error({ err: err.message }, 'password reset email failed');
  }
}

export async function resetPassword(token, newPassword) {
  const record = await prisma.passwordReset.findUnique({ where: { tokenHash: sha256(token) } });
  if (!record || record.usedAt || record.expiresAt <= new Date()) {
    throw new HttpError(400, 'INVALID_RESET_TOKEN', 'This reset link is invalid or has expired');
  }
  // Claim the token atomically so it can only be used once.
  const claimed = await prisma.passwordReset.updateMany({
    // MongoDB: a never-written optional field is *missing*, not null, so match both.
    where: { id: record.id, OR: [{ usedAt: null }, { usedAt: { isSet: false } }] },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) throw new HttpError(400, 'INVALID_RESET_TOKEN', 'This reset link is invalid or has expired');
  await prisma.user.update({
    where: { id: record.subjectId },
    data: { passwordHash: await hashPassword(newPassword) },
  });
  await destroyAllSessions('user', record.subjectId);
  await notifyPasswordChanged(await prisma.user.findUnique({ where: { id: record.subjectId } }));
}

/** Best-effort security notice; never blocks or fails the request. */
async function notifyPasswordChanged(account) {
  if (!account?.email) return;
  try {
    await sendMail({ to: account.email, ...passwordChangedEmail({ firstName: account.firstName ?? 'there' }) });
  } catch (err) {
    logger.error({ err: err.message }, 'password-changed notification failed');
  }
}

export async function changePassword(auth, currentPassword, newPassword) {
  const model = auth.type === 'admin' ? prisma.admin : prisma.user;
  const subject = await model.findUnique({ where: { id: auth.id } });
  const ok = await bcrypt.compare(currentPassword, subject?.passwordHash ?? DUMMY_HASH);
  if (!subject || !ok) throw unauthorized('Current password is incorrect');
  await model.update({
    where: { id: auth.id },
    data: {
      passwordHash: await hashPassword(newPassword),
      ...(auth.type === 'admin' ? { mustChangePassword: false } : {}),
    },
  });
  // keep this session, drop every other one
  await prisma.session.deleteMany({
    where: { subjectType: auth.type, subjectId: auth.id, NOT: { id: auth.sessionId } },
  });
  await notifyPasswordChanged(subject);
}
