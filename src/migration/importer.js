import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { normalizeEmail, normalizeKey } from '../utils/ids.js';
import {
  manufacturerInputToData,
  toDate,
  toNum,
  toStr,
  toStrArray,
} from '../utils/manufacturer.js';

/**
 * Firestore -> MongoDB import. Pure library: the CLI (scripts/import-firestore.js)
 * loads the JSON export and passes a Prisma client; tests pass an in-memory fake.
 *
 * Guarantees
 *  - never writes to or deletes from Firebase (it only reads local export files)
 *  - idempotent: a MigrationLedger row per source document + a checksum of the
 *    transformed payload, so reruns skip unchanged docs and update changed ones
 *  - dependency-aware order: filters -> manufacturers -> settings -> reviews ->
 *    admins -> users -> subscribers
 *  - dry-run mode performs every read/transform and reports what *would* happen
 *  - plaintext passwords (the old `admins.password`) are bcrypt-hashed in memory
 *    and never written to the ledger, the report or the log
 */

export const COLLECTION_ORDER = [
  'tags', 'category', 'region', 'manufacturerType', 'manufacturer',
  'countries', 'currency', 'payment', 'delivery', 'reviews', 'admins', 'users', 'subscribers',
];

const stableStringify = (v) =>
  JSON.stringify(v, (_k, val) => {
    if (val instanceof Date) return val.toISOString();
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]));
    }
    return val;
  });
const checksum = (v) => crypto.createHash('sha256').update(stableStringify(v)).digest('hex');

export const unwrap = (doc) => {
  const body = doc && typeof doc === 'object' && doc.data && typeof doc.data === 'object' ? doc.data : doc;
  return { id: String(doc.id ?? doc.uid ?? ''), ...body };
};

function newReport() {
  const stats = {};
  const bump = (collection, key, n = 1) => {
    stats[collection] ??= { read: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
    stats[collection][key] += n;
  };
  return { stats, bump, failures: [], warnings: [] };
}

export async function runImport({ prisma, data, dryRun = false, only, bcryptRounds = 12, log = () => {} }) {
  const report = newReport();
  const selected = new Set(only?.length ? only : COLLECTION_ORDER);
  const fail = (collection, id, reason) => {
    report.bump(collection, 'failed');
    report.failures.push({ collection, id, reason });
  };
  const warn = (collection, id, message) => report.warnings.push({ collection, id, message });

  // Maps filled as we go: legacy id -> new id (used by dependent phases).
  const manufacturerByLegacy = new Map();
  const manufacturerByKey = new Map();
  const userByEmail = new Map();

  async function record({ collection, legacyId, model, payload, create, update, findExisting }) {
    const sourceKey = `${collection}:${legacyId}`;
    const sum = checksum(payload);
    const ledger = await prisma.migrationLedger.findUnique({ where: { sourceKey } });

    if (ledger) {
      if (ledger.checksum === sum) {
        report.bump(collection, 'skipped');
        return { id: ledger.targetId, outcome: 'skipped' };
      }
      if (!dryRun) {
        await update(ledger.targetId);
        await prisma.migrationLedger.update({ where: { sourceKey }, data: { checksum: sum } });
      }
      report.bump(collection, 'updated');
      return { id: ledger.targetId, outcome: 'updated' };
    }

    const existing = findExisting ? await findExisting() : null;
    if (existing) {
      // Same natural key already present (e.g. created by the live app): link, don't duplicate.
      if (!dryRun) {
        await prisma.migrationLedger.create({
          data: { sourceKey, collection, legacyId, targetModel: model, targetId: existing.id, checksum: sum },
        });
      }
      warn(collection, legacyId, 'matching record already exists; linked instead of creating');
      report.bump(collection, 'skipped');
      return { id: existing.id, outcome: 'linked' };
    }

    // A well-formed but non-existent ObjectId: dependent phases still query MongoDB with it
    // (and find nothing), whereas a text placeholder makes the real driver throw.
    let id = crypto.randomBytes(12).toString('hex');
    if (!dryRun) {
      const row = await create();
      id = row.id;
      await prisma.migrationLedger.create({
        data: { sourceKey, collection, legacyId, targetModel: model, targetId: id, checksum: sum },
      });
    }
    report.bump(collection, 'created');
    return { id, outcome: 'created' };
  }

  // ───────────── simple filter lists ─────────────
  const simple = [
    ['tags', 'tag', 'tag'],
    ['category', 'category', 'category'],
    ['region', 'region', 'region'],
  ];
  for (const [collection, model, field] of simple) {
    if (!selected.has(collection)) continue;
    for (const raw of data.collections[collection] ?? []) {
      const doc = unwrap(raw);
      report.bump(collection, 'read');
      const value = toStr(doc[field])?.trim();
      if (!value) { fail(collection, doc.id, `missing ${field}`); continue; }
      const key = normalizeKey(value);
      try {
        await record({
          collection, legacyId: doc.id, model, payload: { [field]: value, key },
          create: () => prisma[model].create({ data: { [field]: value, key, legacyFirebaseId: doc.id } }),
          update: (id) => prisma[model].update({ where: { id }, data: { [field]: value, key } }),
          findExisting: () => prisma[model].findUnique({ where: { key } }),
        });
      } catch (e) { fail(collection, doc.id, e.message); }
    }
  }

  if (selected.has('manufacturerType')) {
    for (const raw of data.collections.manufacturerType ?? []) {
      const doc = unwrap(raw);
      report.bump('manufacturerType', 'read');
      // Legacy wrapper: { manufacturerType: [ {typeName, typeImage}, ... ] }
      const entries = Array.isArray(doc.manufacturerType) ? doc.manufacturerType : doc.typeName ? [doc] : [];
      if (entries.length === 0) { fail('manufacturerType', doc.id, 'no type entries'); continue; }
      for (const [i, e] of entries.entries()) {
        const typeName = toStr(e.typeName)?.trim();
        if (!typeName) { fail('manufacturerType', `${doc.id}#${i}`, 'missing typeName'); continue; }
        const key = normalizeKey(typeName);
        const typeImage = toStr(e.typeImage);
        try {
          await record({
            collection: 'manufacturerType', legacyId: `${doc.id}#${i}`, model: 'manufacturerType',
            payload: { typeName, key, typeImage },
            create: () => prisma.manufacturerType.create({ data: { typeName, key, typeImage, legacyFirebaseId: doc.id } }),
            update: (id) => prisma.manufacturerType.update({ where: { id }, data: { typeName, typeImage } }),
            findExisting: () => prisma.manufacturerType.findUnique({ where: { key } }),
          });
        } catch (err) { fail('manufacturerType', `${doc.id}#${i}`, err.message); }
      }
    }
  }

  // ───────────── manufacturers (+ embedded reviews) ─────────────
  // Always index manufacturers already in the DB so partial reruns can still resolve references.
  const existingM = await prisma.manufacturer.findMany({});
  for (const m of existingM) {
    manufacturerByKey.set(m.companyKey, m.id);
    if (m.legacyFirebaseId) manufacturerByLegacy.set(m.legacyFirebaseId, m.id);
  }

  const embeddedReviews = [];
  if (selected.has('manufacturer')) {
    const seenKeys = new Map();
    for (const raw of data.collections.manufacturer ?? []) {
      const doc = unwrap(raw);
      report.bump('manufacturer', 'read');
      const { id: legacyId, reviews, ...fields } = doc;
      const { data: mapped, warnings } = manufacturerInputToData(fields);
      for (const w of warnings) warn('manufacturer', legacyId, w);

      if (!mapped.company?.trim()) { fail('manufacturer', legacyId, 'missing company name'); continue; }
      if (mapped.latitude == null || mapped.longitude == null) warn('manufacturer', legacyId, 'no usable coordinates; will not appear on the map');
      if (seenKeys.has(mapped.companyKey)) {
        fail('manufacturer', legacyId, `duplicate company name "${mapped.company}" (first seen in ${seenKeys.get(mapped.companyKey)}); settings are keyed by company, resolve manually`);
        continue;
      }
      seenKeys.set(mapped.companyKey, legacyId);
      try {
        const res = await record({
          collection: 'manufacturer', legacyId, model: 'manufacturer',
          payload: mapped,
          create: () => prisma.manufacturer.create({ data: { ...mapped, createdAt: mapped.createdAt ?? new Date(), legacyFirebaseId: legacyId } }),
          update: (id) => { const { createdAt, ...rest } = mapped; return prisma.manufacturer.update({ where: { id }, data: rest }); },
          findExisting: () => prisma.manufacturer.findFirst({ where: { companyKey: mapped.companyKey } }),
        });
        manufacturerByLegacy.set(legacyId, res.id);
        manufacturerByKey.set(mapped.companyKey, res.id);
        if (Array.isArray(reviews)) embeddedReviews.push({ legacyId, reviews });
      } catch (e) { fail('manufacturer', legacyId, e.message); }
    }
  }

  // ───────────── per-manufacturer settings ─────────────
  const settings = {
    countries: { model: 'countrySetting', listKey: 'country', map: (v) => toStrArray(v), dedupe: (x) => normalizeKey(x) },
    payment: { model: 'paymentSetting', listKey: 'payment', map: (v) => toStrArray(v), dedupe: (x) => normalizeKey(x) },
    currency: {
      model: 'currencySetting', listKey: 'currency',
      map: (v, ctx) => (Array.isArray(v) ? v : [])
        .filter((c) => c && typeof c === 'object' && c.name)
        .map((c) => ({ name: String(c.name).toUpperCase(), symbol: toStr(c.symbol) ?? '', rate: toNum(c.rate, 0) }))
        .filter((c) => {
          if (c.rate > 0 && c.symbol) return true;
          ctx.warn(`currency "${c.name}" dropped (needs symbol and rate > 0)`);
          return false;
        }),
      dedupe: (x) => `${x.name}|${x.symbol}`,
    },
    delivery: {
      model: 'deliverySetting', listKey: 'delivery',
      map: (v) => (Array.isArray(v) ? v : [])
        .filter((d) => d && typeof d === 'object' && d.name)
        .map((d) => ({ name: String(d.name), timeFrame: toStr(d.timeFrame) ?? '', price: toNum(d.price, 0), serviceType: toStr(d.serviceType) })),
      dedupe: (x) => normalizeKey(x.name),
    },
  };

  for (const collection of ['countries', 'currency', 'payment', 'delivery']) {
    if (!selected.has(collection)) continue;
    const cfg = settings[collection];
    // Several legacy docs can exist for one company (race on create); merge them.
    const grouped = new Map();
    for (const raw of data.collections[collection] ?? []) {
      const doc = unwrap(raw);
      report.bump(collection, 'read');
      const key = normalizeKey(doc.company);
      const manufacturerId = manufacturerByKey.get(key);
      if (!key || !manufacturerId) { fail(collection, doc.id, `no manufacturer named "${doc.company ?? ''}"`); continue; }

      let items = cfg.map(doc[cfg.listKey], { warn: (m) => warn(collection, doc.id, m) });
      // Legacy bug (AddDelivery): partners added after the first were written to `currency`, without price.
      if (collection === 'delivery' && Array.isArray(doc.currency)) {
        const stray = doc.currency.filter((c) => c && c.name && c.timeFrame !== undefined);
        if (stray.length) {
          warn(collection, doc.id, `${stray.length} delivery partner(s) recovered from the misnamed "currency" field; their price was never stored — set prices manually`);
          items = items.concat(cfg.map(stray));
        }
      }
      const g = grouped.get(manufacturerId) ?? { manufacturerId, legacyIds: [], items: [] };
      g.legacyIds.push(doc.id);
      g.items.push(...items);
      grouped.set(manufacturerId, g);
    }
    for (const g of grouped.values()) {
      const seen = new Set();
      const items = g.items.filter((x) => { const k = cfg.dedupe(x); if (seen.has(k)) return false; seen.add(k); return true; });
      if (g.legacyIds.length > 1) warn(collection, g.legacyIds.join('+'), `${g.legacyIds.length} documents merged for one company`);
      try {
        await record({
          collection, legacyId: g.legacyIds[0], model: cfg.model,
          payload: { manufacturerId: g.manufacturerId, items },
          create: () => prisma[cfg.model].create({ data: { manufacturerId: g.manufacturerId, [cfg.listKey]: items, legacyFirebaseId: g.legacyIds[0] } }),
          update: (id) => prisma[cfg.model].update({ where: { id }, data: { [cfg.listKey]: { set: items } } }),
          findExisting: () => prisma[cfg.model].findUnique({ where: { manufacturerId: g.manufacturerId } }),
        });
      } catch (e) { fail(collection, g.legacyIds[0], e.message); }
    }
  }

  // ───────────── reviews (extracted from manufacturer docs) ─────────────
  if (selected.has('reviews') || selected.has('manufacturer')) {
    for (const { legacyId, reviews } of embeddedReviews) {
      const manufacturerId = manufacturerByLegacy.get(legacyId);
      if (!manufacturerId) continue;
      let count = 0, rated = 0, sum = 0;
      for (const r of reviews) {
        report.bump('reviews', 'read');
        if (!r || typeof r !== 'object' || !toStr(r.comment)) { fail('reviews', `${legacyId}`, 'review without comment skipped'); continue; }
        const rate = Math.min(5, Math.max(0, Math.round(toNum(r.rate, 0))));
        const createdAt = toDate(r.createdAt) ?? new Date();
        const legacyUid = toStr(r.uid) ?? null;
        const stable = crypto.createHash('sha1').update(`${legacyUid}|${createdAt.toISOString()}|${r.comment}`).digest('hex').slice(0, 16);
        count += 1; if (rate >= 1) { rated += 1; sum += rate; }
        try {
          await record({
            collection: 'reviews', legacyId: `${legacyId}:${stable}`, model: 'review',
            payload: { manufacturerId, legacyUid, name: r.name, comment: r.comment, rate, createdAt },
            create: () => prisma.review.create({ data: { manufacturerId, legacyUid, name: toStr(r.name) || 'Customer', comment: String(r.comment), rate, createdAt } }),
            update: () => Promise.resolve(),
          });
        } catch (e) { fail('reviews', `${legacyId}:${stable}`, e.message); }
      }
      if (!dryRun) {
        // Counters are recomputed from the source (not incremented) so reruns stay exact.
        await prisma.manufacturer.update({ where: { id: manufacturerId }, data: { reviewCount: count, ratingCount: rated, ratingSum: sum } });
      }
    }
  }

  // ───────────── admins ─────────────
  if (selected.has('admins')) {
    for (const raw of data.collections.admins ?? []) {
      const doc = unwrap(raw);
      report.bump('admins', 'read');
      const email = normalizeEmail(doc.email);
      if (!email) { fail('admins', doc.id, 'missing email'); continue; }
      const role = doc.role === 'superadmin' ? 'superadmin' : 'admin';
      const profile = { email, firstName: toStr(doc.firstName) ?? '', lastName: toStr(doc.lastName) ?? '', role };
      try {
        await record({
          collection: 'admins', legacyId: doc.id, model: 'admin',
          payload: profile, // password intentionally excluded from the checksum/ledger
          create: async () => {
            const plain = toStr(doc.password);
            // The old plaintext password sat in a client-readable DB: treat it as compromised.
            // We hash it so existing admins can still sign in once, then force a change.
            const passwordHash = plain
              ? await bcrypt.hash(plain, bcryptRounds)
              : await bcrypt.hash(crypto.randomBytes(24).toString('base64url'), bcryptRounds);
            return prisma.admin.create({ data: { ...profile, passwordHash, mustChangePassword: true, legacyFirebaseId: doc.id } });
          },
          update: (id) => prisma.admin.update({ where: { id }, data: profile }), // never touches the password
          findExisting: () => prisma.admin.findUnique({ where: { email } }),
        });
        if (!doc.password) warn('admins', doc.id, 'no password in source; random one set, use a super admin to set a new one');
      } catch (e) { fail('admins', doc.id, e.message); }
    }
  }

  // ───────────── users (Firestore profile + Auth export) ─────────────
  if (selected.has('users')) {
    const byEmail = new Map();
    // Earlier sources win; later ones only fill blanks (Firestore profile first, then the Auth export).
    const add = (email, patch, source) => {
      const cur = byEmail.get(email) ?? { sources: [] };
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined && v !== '' && (cur[k] === undefined || cur[k] === '')) cur[k] = v;
      }
      cur.sources.push(source);
      byEmail.set(email, cur);
    };
    for (const raw of data.collections.users ?? []) {
      const doc = unwrap(raw);
      report.bump('users', 'read');
      const email = normalizeEmail(doc.email);
      if (!email) { fail('users', doc.id, 'missing email'); continue; }
      if (byEmail.has(email) && byEmail.get(email).sources.includes('firestore')) {
        warn('users', doc.id, 'duplicate profile for the same email; first one kept');
        report.bump('users', 'skipped');
        continue;
      }
      add(email, {
        legacyFirebaseUid: toStr(doc.uid),
        firstName: toStr(doc.first_name) ?? '', lastName: toStr(doc.last_name) ?? '',
        phone: toStr(doc.phone), address: toStr(doc.address), zipCode: toStr(doc.zipCode),
        deliveryAddress: doc.delivery_address === true,
        createdAt: toDate(doc.createdAt),
        legacyId: doc.id,
      }, 'firestore');
    }
    for (const u of data.authUsers ?? []) {
      const email = normalizeEmail(u.email);
      if (!email) continue;
      const [first = '', ...rest] = String(u.displayName ?? '').trim().split(/\s+/);
      const existed = byEmail.has(email);
      if (!existed) report.bump('users', 'read');
      add(email, {
        legacyFirebaseUid: toStr(u.uid), firstName: first, lastName: rest.join(' '),
        phone: toStr(u.phoneNumber), createdAt: toDate(u.metadata?.creationTime ?? u.createdAt),
        disabled: u.disabled === true, legacyId: toStr(u.uid),
      }, 'auth');
    }
    for (const [email, u] of byEmail) {
      const legacyId = u.legacyId ?? u.legacyFirebaseUid ?? email;
      const payload = {
        email, firstName: u.firstName || 'Customer', lastName: u.lastName ?? '', phone: u.phone, address: u.address,
        zipCode: u.zipCode, deliveryAddress: u.deliveryAddress === true, disabled: u.disabled === true,
        legacyFirebaseUid: u.legacyFirebaseUid,
      };
      try {
        const res = await record({
          collection: 'users', legacyId, model: 'user', payload,
          // passwordHash stays null: the customer sets a password through "Forgot password".
          create: () => prisma.user.create({ data: { ...payload, passwordHash: null, createdAt: u.createdAt ?? new Date() } }),
          update: (id) => prisma.user.update({ where: { id }, data: payload }),
          findExisting: () => prisma.user.findUnique({ where: { email } }),
        });
        userByEmail.set(email, res.id);
      } catch (e) { fail('users', legacyId, e.message); }
    }
  }

  // ───────────── subscribers ─────────────
  if (selected.has('subscribers')) {
    const seen = new Set();
    for (const raw of data.collections.subscribers ?? []) {
      const doc = unwrap(raw);
      report.bump('subscribers', 'read');
      const email = normalizeEmail(doc.email);
      if (!email) { fail('subscribers', doc.id, 'missing email'); continue; }
      if (seen.has(email)) { report.bump('subscribers', 'skipped'); warn('subscribers', doc.id, 'duplicate email; skipped'); continue; }
      seen.add(email);
      try {
        await record({
          collection: 'subscribers', legacyId: doc.id, model: 'subscriber', payload: { email },
          create: () => prisma.subscriber.create({ data: { email, legacyFirebaseId: doc.id } }),
          update: () => Promise.resolve(),
          findExisting: () => prisma.subscriber.findUnique({ where: { email } }),
        });
      } catch (e) { fail('subscribers', doc.id, e.message); }
    }
  }

  const carts = data.collections.carts?.length ?? 0;
  if (carts) {
    warn('carts', '*', `${carts} cart document(s) intentionally NOT migrated: items reference no manufacturer/product id, and carts are transient.`);
  }

  return { dryRun, stats: report.stats, failures: report.failures, warnings: report.warnings };
}
