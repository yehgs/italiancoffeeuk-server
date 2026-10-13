import { prisma } from '../config/prisma.js';
import { conflict, forbidden, notFound } from '../utils/httpError.js';
import { normalizeEmail } from '../utils/ids.js';
import { destroyAllSessions, hashPassword, publicAdmin } from './authService.js';

export async function listAdmins() {
  const rows = await prisma.admin.findMany({ orderBy: { createdAt: 'asc' }, take: 500 });
  return rows.map(publicAdmin); // passwordHash is never returned
}

export async function createAdmin(body) {
  const email = normalizeEmail(body.email);
  if (await prisma.admin.findUnique({ where: { email } })) {
    throw conflict('Email Already in use', 'EMAIL_IN_USE');
  }
  try {
    const admin = await prisma.admin.create({
      data: {
        email,
        firstName: body.firstName,
        lastName: body.lastName,
        role: body.role ?? 'admin',
        passwordHash: await hashPassword(body.password),
        // the creator knows the password, so the new admin must change it
        mustChangePassword: true,
      },
    });
    return publicAdmin(admin);
  } catch (e) {
    if (e?.code === 'P2002') throw conflict('Email Already in use', 'EMAIL_IN_USE');
    throw e;
  }
}

async function activeSuperAdminCount() {
  return prisma.admin.count({ where: { role: 'superadmin', disabled: false } });
}

export async function updateAdmin(id, body, actor) {
  const target = await prisma.admin.findUnique({ where: { id } });
  if (!target) throw notFound('Admin not found');

  const demoting = body.role && body.role !== 'superadmin' && target.role === 'superadmin';
  const disabling = body.disabled === true && target.role === 'superadmin';
  if ((demoting || disabling) && (await activeSuperAdminCount()) <= 1) {
    throw forbidden('You cannot remove the last active super admin');
  }
  if (id === actor.id && (body.role && body.role !== actor.role)) {
    throw forbidden('You cannot change your own role');
  }

  const data = {};
  for (const k of ['firstName', 'lastName', 'role', 'disabled']) if (body[k] !== undefined) data[k] = body[k];
  if (body.email !== undefined) {
    data.email = normalizeEmail(body.email);
    const clash = await prisma.admin.findUnique({ where: { email: data.email } });
    if (clash && clash.id !== id) throw conflict('Email Already in use', 'EMAIL_IN_USE');
  }
  if (body.password !== undefined) {
    data.passwordHash = await hashPassword(body.password);
    data.mustChangePassword = id !== actor.id;
  }
  const updated = await prisma.admin.update({ where: { id }, data });
  if (body.password !== undefined || body.disabled === true || body.role !== undefined) {
    await destroyAllSessions('admin', id);
  }
  return publicAdmin(updated);
}

export async function deleteAdmin(id, actor) {
  if (id === actor.id) throw forbidden('You cannot delete your own account');
  const target = await prisma.admin.findUnique({ where: { id } });
  if (!target) throw notFound('Admin not found');
  if (target.role === 'superadmin' && (await activeSuperAdminCount()) <= 1) {
    throw forbidden('You cannot remove the last active super admin');
  }
  await prisma.admin.delete({ where: { id } });
  await destroyAllSessions('admin', id); // replaces the broken Firebase deleteUser callable
}

/** Creates the first super admin from env when no admin exists yet (idempotent). */
export async function bootstrapAdmin({ email, password, logger }) {
  if (!email || !password) return false;
  if ((await prisma.admin.count()) > 0) return false;
  await prisma.admin.create({
    data: {
      email: normalizeEmail(email),
      firstName: 'Super',
      lastName: 'Admin',
      role: 'superadmin',
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
    },
  });
  logger?.info('Bootstrapped initial super admin (change the password at first login)');
  return true;
}
