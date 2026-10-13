import { prisma } from '../config/prisma.js';
import { conflict, notFound } from '../utils/httpError.js';
import { normalizeKey } from '../utils/ids.js';

/** tags / categories / regions / manufacturer-types — small admin-managed lists. */
const KINDS = {
  tags: { model: 'tag', field: 'tag' },
  categories: { model: 'category', field: 'category' },
  regions: { model: 'region', field: 'region' },
  'manufacturer-types': { model: 'manufacturerType', field: 'typeName' },
};

const kind = (name) => {
  const k = KINDS[name];
  if (!k) throw notFound('Unknown list');
  return k;
};

function out(name, row) {
  if (name === 'manufacturer-types') {
    // keep the legacy wrapper so existing screens work unchanged
    return {
      id: row.id,
      typeName: row.typeName,
      typeImage: row.typeImage ?? '',
      manufacturerType: [{ typeName: row.typeName, typeImage: row.typeImage ?? '' }],
    };
  }
  return { id: row.id, [kind(name).field]: row[kind(name).field] };
}

export async function listFilter(name) {
  const k = kind(name);
  const rows = await prisma[k.model].findMany({ orderBy: { createdAt: 'asc' }, take: 1000 });
  return rows.map((r) => out(name, r));
}

export async function createFilter(name, body) {
  const k = kind(name);
  const key = normalizeKey(body[k.field]);
  const existing = await prisma[k.model].findUnique({ where: { key } });
  if (existing) throw conflict(`${name === 'manufacturer-types' ? 'Manufacturer Type' : 'This entry'} already exists!`, 'DUPLICATE');
  try {
    const row = await prisma[k.model].create({
      data: { [k.field]: body[k.field], key, ...(name === 'manufacturer-types' ? { typeImage: body.typeImage } : {}) },
    });
    return out(name, row);
  } catch (e) {
    if (e?.code === 'P2002') throw conflict('This entry already exists!', 'DUPLICATE');
    throw e;
  }
}

export async function updateFilter(name, id, body) {
  const k = kind(name);
  const existing = await prisma[k.model].findUnique({ where: { id } });
  if (!existing) throw notFound();
  const data = {};
  if (body[k.field] !== undefined) {
    const key = normalizeKey(body[k.field]);
    const clash = await prisma[k.model].findUnique({ where: { key } });
    if (clash && clash.id !== id) throw conflict('This entry already exists!', 'DUPLICATE');
    data[k.field] = body[k.field];
    data.key = key;
  }
  if (name === 'manufacturer-types' && body.typeImage !== undefined) data.typeImage = body.typeImage;
  const row = await prisma[k.model].update({ where: { id }, data });
  return out(name, row);
}

export async function deleteFilter(name, id) {
  const k = kind(name);
  const existing = await prisma[k.model].findUnique({ where: { id } });
  if (!existing) throw notFound();
  await prisma[k.model].delete({ where: { id } });
}
