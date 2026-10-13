import { prisma } from '../config/prisma.js';
import { notFound } from '../utils/httpError.js';
import { reviewToLegacy } from '../utils/manufacturer.js';

export async function listReviews(manufacturerId, { page, limit }) {
  const [rows, total] = await Promise.all([
    prisma.review.findMany({
      where: { manufacturerId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.review.count({ where: { manufacturerId } }),
  ]);
  return { items: rows.map(reviewToLegacy), total };
}

/** Review insert and the manufacturer's counters change atomically (needs a replica set). */
export async function addReview(manufacturerId, user, { comment, rate }) {
  const m = await prisma.manufacturer.findUnique({ where: { id: manufacturerId }, select: { id: true } });
  if (!m) throw notFound('Manufacturer not found');
  const name = `${user.firstName} ${user.lastName}`.trim() || 'Customer';
  const [review] = await prisma.$transaction([
    prisma.review.create({ data: { manufacturerId, userId: user.id, name, comment, rate } }),
    prisma.manufacturer.update({
      where: { id: manufacturerId },
      data: {
        reviewCount: { increment: 1 },
        ...(rate >= 1 ? { ratingCount: { increment: 1 }, ratingSum: { increment: rate } } : {}),
      },
    }),
  ]);
  return reviewToLegacy(review);
}
