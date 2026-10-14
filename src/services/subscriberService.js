import { prisma } from '../config/prisma.js';
import { conflict, notFound } from '../utils/httpError.js';
import { normalizeEmail } from '../utils/ids.js';

const out = (s) => ({ id: s.id, email: s.email, createdAt: s.createdAt instanceof Date ? s.createdAt.toISOString() : s.createdAt });

export async function subscribe(emailInput) {
  const email = normalizeEmail(emailInput);
  try {
    return out(await prisma.subscriber.create({ data: { email } }));
  } catch (e) {
    // The unique index (not a read-then-write check) is what prevents the race.
    if (e?.code === 'P2002') throw conflict('Email is already subscribed', 'ALREADY_SUBSCRIBED');
    throw e;
  }
}

/**
 * Public unsubscribe. Always resolves the same way whether or not the address was
 * subscribed, so the endpoint cannot be used to discover who is on the list.
 */
export async function unsubscribe(emailInput) {
  const email = normalizeEmail(emailInput);
  await prisma.subscriber.deleteMany({ where: { email } });
}

export async function listSubscribers({ page, limit }) {
  const [rows, total] = await Promise.all([
    prisma.subscriber.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.subscriber.count(),
  ]);
  return { items: rows.map(out), total };
}

export async function deleteSubscriber(id) {
  const existing = await prisma.subscriber.findUnique({ where: { id } });
  if (!existing) throw notFound();
  await prisma.subscriber.delete({ where: { id } });
}
