import { prisma } from '../config/prisma.js';
import { casUpdate } from '../utils/cas.js';
import { badRequest, conflict, notFound } from '../utils/httpError.js';
import { normalizeKey } from '../utils/ids.js';
import {
  PRODUCT_SECTIONS,
  VISIBILITY_FIELDS,
  manufacturerInputToData,
  manufacturerToLegacy,
  normalizeProduct,
} from '../utils/manufacturer.js';

const DETAIL_REVIEW_LIMIT = 50;

export async function listManufacturers({ page, limit, q, province }) {
  const where = {
    ...(q ? { companyKey: { contains: normalizeKey(q) } } : {}),
    ...(province ? { province } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.manufacturer.findMany({
      where,
      orderBy: { company: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.manufacturer.count({ where }),
  ]);
  return { items: rows.map((m) => manufacturerToLegacy(m)), total };
}

export async function getManufacturer(id) {
  const m = await prisma.manufacturer.findUnique({ where: { id } });
  if (!m) throw notFound('Manufacturer not found');
  const reviews = await prisma.review.findMany({
    where: { manufacturerId: id },
    orderBy: { createdAt: 'desc' },
    take: DETAIL_REVIEW_LIMIT,
  });
  return manufacturerToLegacy(m, { reviews });
}

async function assertCompanyFree(company, exceptId) {
  const existing = await prisma.manufacturer.findFirst({ where: { companyKey: normalizeKey(company) } });
  if (existing && existing.id !== exceptId) {
    throw conflict('A manufacturer with this company name already exists', 'COMPANY_EXISTS');
  }
}

export async function createManufacturer(body, admin) {
  const { data, warnings } = manufacturerInputToData(body);
  if (!data.company?.trim()) throw badRequest('Company name is required');
  if (data.latitude == null || data.longitude == null) {
    throw badRequest('Longitude and Latitude are Required');
  }
  await assertCompanyFree(data.company);
  const created = await prisma.manufacturer.create({
    data: {
      ...data,
      createdBy: data.createdBy || `${admin.firstName} ${admin.lastName}`.trim(),
      // CreateData always sent a product row; keep stable ids on every item.
    },
  });
  return { manufacturer: manufacturerToLegacy(created), warnings };
}

export async function updateManufacturer(id, body) {
  const { data, warnings } = manufacturerInputToData(body);
  if (Object.keys(data).length === 0) throw badRequest('Nothing to update');
  // createdAt/createdBy are immutable audit fields.
  delete data.createdAt;
  delete data.createdBy;
  if (data.company !== undefined) {
    if (!data.company?.trim()) throw badRequest('Company name is required');
    await assertCompanyFree(data.company, id);
  }
  const existing = await prisma.manufacturer.findUnique({ where: { id } });
  if (!existing) throw notFound('Manufacturer not found');
  const updated = await prisma.manufacturer.update({ where: { id }, data });
  return { manufacturer: manufacturerToLegacy(updated), warnings };
}

export async function deleteManufacturer(id) {
  const existing = await prisma.manufacturer.findUnique({ where: { id } });
  if (!existing) throw notFound('Manufacturer not found');
  // Reviews and per-manufacturer settings are removed by the relation cascade.
  await prisma.manufacturer.delete({ where: { id } });
}

export async function setManufacturerVisibility(id, field, value) {
  if (!VISIBILITY_FIELDS.includes(field)) throw badRequest('Unknown visibility field');
  const existing = await prisma.manufacturer.findUnique({ where: { id } });
  if (!existing) throw notFound('Manufacturer not found');
  const updated = await prisma.manufacturer.update({ where: { id }, data: { [field]: Boolean(value) } });
  return manufacturerToLegacy(updated);
}

export async function setProductVisibility(id, section, productId, visible) {
  const field = PRODUCT_SECTIONS[section];
  if (!field) throw badRequest('Unknown product section');
  const updated = await casUpdate(prisma.manufacturer, { id }, (m) => {
    const list = m[field] ?? [];
    if (!list.some((p) => p.productId === productId)) throw notFound('Product not found');
    return { [field]: { set: list.map((p) => (p.productId === productId ? { ...p, visibility: Boolean(visible) } : p)) } };
  });
  return manufacturerToLegacy(updated);
}

/** Used by the cart: resolves a product and whether it may currently be sold. */
export async function resolveSellableProduct(manufacturerId, section, productId) {
  const field = PRODUCT_SECTIONS[section];
  if (!field) throw badRequest('Unknown product section');
  const m = await prisma.manufacturer.findUnique({ where: { id: manufacturerId } });
  if (!m) throw notFound('Manufacturer not found');
  const product = (m[field] ?? []).find((p) => p.productId === productId);
  if (!product) throw notFound('Product not found');
  const sectionVisibleField = {
    products: 'visibility',
    coffeeBeans: 'coffeeBeansVisibility',
    compatibleCapsules: 'compatibleCapsuleVisibility',
    esePods: 'esePodsVisibility',
    grindedCoffee: 'grindedCoffeeVisibility',
  }[field];
  const sellable = m[sectionVisibleField] !== false && product.visibility !== false && product.price > 0;
  return { manufacturer: m, product, sellable };
}

export { normalizeProduct };
