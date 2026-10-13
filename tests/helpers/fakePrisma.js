import crypto from 'node:crypto';

/**
 * Minimal in-memory stand-in for the Prisma client, covering exactly the
 * operations the services use. Emulates unique indexes (P2002), `set` /
 * `increment` update operators, relation `include` for a few models, and a
 * strictly increasing `updatedAt` so optimistic-concurrency paths are real.
 */
const UNIQUE = {
  user: ['email'],
  admin: ['email'],
  session: ['tokenHash'],
  passwordReset: ['tokenHash'],
  tag: ['key'],
  category: ['key'],
  region: ['key'],
  manufacturerType: ['key'],
  countrySetting: ['manufacturerId'],
  currencySetting: ['manufacturerId'],
  paymentSetting: ['manufacturerId'],
  deliverySetting: ['manufacturerId'],
  subscriber: ['email'],
  cart: ['userId'],
  migrationLedger: ['sourceKey'],
};
const HAS_UPDATED_AT = new Set([
  'user', 'admin', 'manufacturer', 'countrySetting', 'currencySetting', 'paymentSetting', 'deliverySetting', 'cart', 'migrationLedger',
]);
const MODELS = [
  'user', 'admin', 'session', 'passwordReset', 'manufacturer', 'review', 'tag', 'category', 'region',
  'manufacturerType', 'countrySetting', 'currencySetting', 'paymentSetting', 'deliverySetting',
  'subscriber', 'cart', 'migrationLedger',
];

const clone = (v) => structuredClone(v);
const objectId = () => crypto.randomBytes(12).toString('hex');

function matches(row, where = {}) {
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'NOT') return !matches(row, cond);
    if (k === 'AND') return [].concat(cond).every((c) => matches(row, c));
    if (k === 'OR') return [].concat(cond).some((c) => matches(row, c));
    const v = row[k];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('contains' in cond) return String(v ?? '').includes(cond.contains);
      if ('not' in cond) return v !== cond.not;
      if ('in' in cond) return cond.in.includes(v);
      if ('equals' in cond) return v === cond.equals;
      if ('has' in cond) return Array.isArray(v) && v.includes(cond.has);
      if ('isSet' in cond) return cond.isSet ? v !== undefined : v === undefined;
      return false;
    }
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    return v === cond;
  });
}

function applyData(row, data) {
  for (const [k, val] of Object.entries(data)) {
    if (val && typeof val === 'object' && !(val instanceof Date) && !Array.isArray(val)) {
      if ('set' in val) { row[k] = clone(val.set); continue; }
      if ('increment' in val) { row[k] = (row[k] ?? 0) + val.increment; continue; }
    }
    row[k] = val instanceof Date ? new Date(val) : clone(val);
  }
}

export function createFakePrisma() {
  const tables = Object.fromEntries(MODELS.map((m) => [m, []]));
  let clock = Date.now();
  const tick = () => new Date((clock += 2));
  const prisma = {};

  const dup = (model, row, ignore) => {
    for (const f of UNIQUE[model] ?? []) {
      if (row[f] != null && tables[model].some((r) => r !== ignore && r[f] === row[f])) {
        const e = new Error(`Unique constraint failed on ${f}`);
        e.code = 'P2002';
        throw e;
      }
    }
  };

  const withDefaults = (model, data) => {
    const now = tick();
    const row = { id: objectId(), createdAt: now, ...clone(data) };
    if (HAS_UPDATED_AT.has(model)) row.updatedAt = now;
    if (model === 'manufacturer') {
      for (const [k, v] of Object.entries({
        companyRate: 0, reviewCount: 0, ratingCount: 0, ratingSum: 0, visibility: true,
        coffeeBeansVisibility: true, compatibleCapsuleVisibility: true, esePodsVisibility: true,
        grindedCoffeeVisibility: true, academy: false, blog: false, sustainability: false, salesOnline: false,
        gallery: [], rangeProducts: [], merchandise: [], otherBrands: [], notOnlyCoffee: [], intlCertification: [],
        global: [], socials: [], manufacturerType: [], products: [], coffeeBeans: [], compatibleCapsules: [],
        esePods: [], grindedCoffee: [],
      })) if (row[k] === undefined) row[k] = v;
    }
    if (model === 'admin') { row.role ??= 'admin'; row.disabled ??= false; row.mustChangePassword ??= false; }
    if (model === 'user') { row.disabled ??= false; row.deliveryAddress ??= false; }
    if (model === 'session') row.lastUsedAt = now;
    return row;
  };

  const include = (model, row, inc) => {
    if (!inc) return clone(row);
    const out = clone(row);
    if (inc.manufacturer) {
      const m = tables.manufacturer.find((x) => x.id === row.manufacturerId);
      out.manufacturer = m ? (inc.manufacturer.select ? { company: m.company } : clone(m)) : null;
    }
    return out;
  };

  for (const model of MODELS) {
    const t = tables[model];
    prisma[model] = {
      async findUnique({ where }) {
        const keys = Object.keys(where);
        return clone(t.find((r) => keys.every((k) => r[k] === where[k])) ?? null) ?? null;
      },
      async findFirst({ where } = {}) {
        return clone(t.find((r) => matches(r, where)) ?? null) ?? null;
      },
      async findMany({ where, orderBy, skip = 0, take, include: inc } = {}) {
        let rows = t.filter((r) => matches(r, where));
        if (orderBy) {
          const [[field, dir]] = Object.entries(orderBy);
          rows = [...rows].sort((a, b) => (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
        }
        rows = rows.slice(skip, take ? skip + take : undefined);
        return rows.map((r) => include(model, r, inc));
      },
      async count({ where } = {}) {
        return t.filter((r) => matches(r, where)).length;
      },
      async create({ data }) {
        const row = withDefaults(model, data);
        dup(model, row);
        t.push(row);
        return clone(row);
      },
      async update({ where, data }) {
        const keys = Object.keys(where);
        const row = t.find((r) => keys.every((k) => r[k] === where[k]));
        if (!row) { const e = new Error('Record not found'); e.code = 'P2025'; throw e; }
        const next = { ...row };
        applyData(next, data);
        dup(model, next, row);
        Object.assign(row, next);
        if (HAS_UPDATED_AT.has(model)) row.updatedAt = tick();
        return clone(row);
      },
      async updateMany({ where, data }) {
        const rows = t.filter((r) => matches(r, where));
        for (const row of rows) {
          applyData(row, data);
          if (HAS_UPDATED_AT.has(model)) row.updatedAt = tick();
        }
        return { count: rows.length };
      },
      async delete({ where }) {
        const keys = Object.keys(where);
        const i = t.findIndex((r) => keys.every((k) => r[k] === where[k]));
        if (i === -1) { const e = new Error('Record not found'); e.code = 'P2025'; throw e; }
        const [removed] = t.splice(i, 1);
        if (model === 'manufacturer') {
          // emulate onDelete: Cascade
          for (const dep of ['review', 'countrySetting', 'currencySetting', 'paymentSetting', 'deliverySetting']) {
            tables[dep] = tables[dep].filter((r) => r.manufacturerId !== removed.id);
            prisma[dep].__rebind(tables[dep]);
          }
        }
        return clone(removed);
      },
      async deleteMany({ where } = {}) {
        const before = t.length;
        for (let i = t.length - 1; i >= 0; i -= 1) if (matches(t[i], where)) t.splice(i, 1);
        return { count: before - t.length };
      },
      async upsert({ where, create, update }) {
        const existing = await this.findUnique({ where });
        return existing ? this.update({ where, data: update }) : this.create({ data: create });
      },
      __rebind(next) { t.length = 0; t.push(...next); tables[model] = t; },
      __rows: () => t,
    };
  }

  prisma.$transaction = async (ops) => Promise.all(ops);
  prisma.$connect = async () => {};
  prisma.$disconnect = async () => {};
  prisma.$runCommandRaw = async () => ({ ok: 1 });
  prisma.__reset = () => { for (const m of MODELS) tables[m].length = 0; };
  prisma.__tables = tables;
  return prisma;
}
