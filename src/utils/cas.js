import { conflict, notFound } from './httpError.js';

/**
 * Optimistic read-modify-write for documents that embed arrays
 * (products, settings lists, cart items). `mutate(current)` returns Prisma
 * update data; the write only lands if `updatedAt` is unchanged, otherwise
 * it retries, so concurrent admins cannot silently overwrite each other.
 */
export async function casUpdate(delegate, where, mutate, { retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const current = await delegate.findUnique({ where });
    if (!current) throw notFound();
    const data = await mutate(current);
    const res = await delegate.updateMany({ where: { ...where, updatedAt: current.updatedAt }, data });
    if (res.count === 1) return delegate.findUnique({ where });
  }
  throw conflict('The record was changed by someone else, please retry', 'CONCURRENT_UPDATE');
}
