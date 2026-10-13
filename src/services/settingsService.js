import { prisma } from '../config/prisma.js';
import { casUpdate } from '../utils/cas.js';
import { badRequest, conflict, notFound } from '../utils/httpError.js';
import { normalizeKey } from '../utils/ids.js';

/**
 * Per-manufacturer settings lists (countries, currencies, payments, deliveries).
 * The legacy Firestore docs were keyed by company *name*; these are owned by
 * manufacturerId, and responses keep the legacy shape: { id, company, <listKey>: [...] }.
 */
export const SETTINGS = {
  countries: {
    model: 'countrySetting',
    listKey: 'country',
    identity: (item) => item,
    same: (a, b) => normalizeKey(a) === normalizeKey(b),
  },
  payments: {
    model: 'paymentSetting',
    listKey: 'payment',
    identity: (item) => item,
    same: (a, b) => normalizeKey(a) === normalizeKey(b),
  },
  currencies: {
    model: 'currencySetting',
    listKey: 'currency',
    identity: (item) => item.name,
    // legacy duplicate rule: same name OR same symbol
    duplicates: (list, item, ignoreName) =>
      list.some((c) => c.name !== ignoreName && (c.name === item.name || c.symbol === item.symbol)),
  },
  deliveries: {
    model: 'deliverySetting',
    listKey: 'delivery',
    identity: (item) => item.name,
    duplicates: (list, item, ignoreName) =>
      list.some((c) => c.name !== ignoreName && normalizeKey(c.name) === normalizeKey(item.name)),
  },
};

const cfg = (type) => {
  const c = SETTINGS[type];
  if (!c) throw notFound('Unknown settings type');
  return c;
};
const delegate = (type) => prisma[cfg(type).model];

function toLegacy(type, row, company) {
  const { listKey } = cfg(type);
  return { id: row.id, manufacturerId: row.manufacturerId, company, [listKey]: row[listKey] ?? [] };
}

async function resolveManufacturer({ manufacturerId, company }) {
  const m = manufacturerId
    ? await prisma.manufacturer.findUnique({ where: { id: manufacturerId } })
    : await prisma.manufacturer.findFirst({ where: { companyKey: normalizeKey(company) } });
  if (!m) throw notFound('Manufacturer not found');
  return m;
}

export async function listSettings(type, target) {
  const d = delegate(type);
  if (target.manufacturerId || target.company) {
    const m = await prisma.manufacturer
      .findFirst({
        where: target.manufacturerId ? { id: target.manufacturerId } : { companyKey: normalizeKey(target.company) },
      });
    if (!m) return [];
    const row = await d.findUnique({ where: { manufacturerId: m.id } });
    return row ? [toLegacy(type, row, m.company)] : [];
  }
  const rows = await d.findMany({ include: { manufacturer: { select: { company: true } } }, take: 1000 });
  return rows.map((r) => toLegacy(type, r, r.manufacturer?.company));
}

export async function addItem(type, target, item) {
  const c = cfg(type);
  const m = await resolveManufacturer(target);
  const d = delegate(type);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await d.findUnique({ where: { manufacturerId: m.id } });
    if (!existing) {
      try {
        const row = await d.create({ data: { manufacturerId: m.id, [c.listKey]: [item] } });
        return toLegacy(type, row, m.company);
      } catch (e) {
        if (e?.code === 'P2002') continue; // lost a create race: fall through and append
        throw e;
      }
    }
    const list = existing[c.listKey] ?? [];
    const dup = c.duplicates ? c.duplicates(list, item) : list.some((x) => c.same(x, item));
    if (dup) throw conflict('This entry already exists for this company', 'DUPLICATE');
    const row = await casUpdate(d, { id: existing.id }, (cur) => ({
      [c.listKey]: { set: [...(cur[c.listKey] ?? []), item] },
    }));
    return toLegacy(type, row, m.company);
  }
  throw conflict('Please retry', 'CONCURRENT_UPDATE');
}

export async function updateItem(type, id, match, item) {
  const c = cfg(type);
  const d = delegate(type);
  const row = await casUpdate(d, { id }, (cur) => {
    const list = cur[c.listKey] ?? [];
    const idx = list.findIndex((x) => (c.identity(x) === match) || (c.same && c.same(c.identity(x), match)));
    if (idx === -1) throw notFound('Entry not found');
    if (c.duplicates && c.duplicates(list, item, c.identity(list[idx]))) {
      throw conflict('This entry already exists for this company', 'DUPLICATE');
    }
    if (c.same && list.some((x, i) => i !== idx && c.same(x, item))) {
      throw conflict('This entry already exists for this company', 'DUPLICATE');
    }
    const next = [...list];
    next[idx] = item;
    return { [c.listKey]: { set: next } };
  });
  const m = await prisma.manufacturer.findUnique({ where: { id: row.manufacturerId } });
  return toLegacy(type, row, m?.company);
}

export async function removeItem(type, id, match) {
  const c = cfg(type);
  if (!match) throw badRequest('match is required');
  const d = delegate(type);
  const row = await casUpdate(d, { id }, (cur) => {
    const list = cur[c.listKey] ?? [];
    const next = list.filter((x) => !(c.identity(x) === match || (c.same && c.same(c.identity(x), match))));
    if (next.length === list.length) throw notFound('Entry not found');
    return { [c.listKey]: { set: next } };
  });
  const m = await prisma.manufacturer.findUnique({ where: { id: row.manufacturerId } });
  return toLegacy(type, row, m?.company);
}
