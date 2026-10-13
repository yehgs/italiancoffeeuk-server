import request from 'supertest';
import { vi } from 'vitest';
import { prisma } from '../../src/config/prisma.js';
import { createApp } from '../../src/app.js';
import * as auth from '../../src/services/authService.js';

export const app = createApp();
export { prisma, request };

export async function seedAdmin({ email = 'root@example.com', password = 'Sup3rSecretPass', role = 'superadmin' } = {}) {
  return prisma.admin.create({
    data: { email, passwordHash: await auth.hashPassword(password), firstName: 'Root', lastName: 'Admin', role },
  });
}
export async function seedCustomer({ email = 'jane@example.com', password = 'Passw0rdOK' } = {}) {
  return prisma.user.create({
    data: { email, passwordHash: await auth.hashPassword(password), firstName: 'Jane', lastName: 'Doe', phone: '123', address: 'x', zipCode: '1' },
  });
}

/** Logs in and returns a supertest agent that carries the cookie + CSRF header. */
export async function login(kind, { email, password }) {
  const agent = request.agent(app);
  const path = kind === 'admin' ? '/api/auth/admin/login' : '/api/auth/login';
  const res = await agent.post(path).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.data.csrfToken;
  const wrap = (method) => (url) => agent[method](url).set('X-CSRF-Token', csrf);
  return { agent, csrf, get: (u) => agent.get(u), post: wrap('post'), patch: wrap('patch'), delete: wrap('delete') };
}
export { vi };
