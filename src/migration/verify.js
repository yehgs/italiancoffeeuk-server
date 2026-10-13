import { normalizeEmail, normalizeKey } from '../utils/ids.js';
import { PRODUCT_SECTIONS, toStr } from '../utils/manufacturer.js';
import { unwrap } from './importer.js';

/**
 * Post-import validation. Pure comparison of the local export against the
 * database; returns a list of findings (never mutates anything).
 */
export async function verifyImport({ prisma, data, checkUrls = false, fetchImpl = globalThis.fetch }) {
  const findings = [];
  const add = (level, check, message) => findings.push({ level, check, message });
  const src = (name) => (data.collections[name] ?? []).map(unwrap);

  // 1. counts (distinct natural keys, since the importer dedupes)
  const distinct = (docs, f) => new Set(docs.map(f).filter(Boolean)).size;
  const expect = {
    manufacturer: [distinct(src('manufacturer'), (d) => normalizeKey(d.company)), await prisma.manufacturer.count({})],
    tags: [distinct(src('tags'), (d) => normalizeKey(d.tag)), await prisma.tag.count({})],
    category: [distinct(src('category'), (d) => normalizeKey(d.category)), await prisma.category.count({})],
    region: [distinct(src('region'), (d) => normalizeKey(d.region)), await prisma.region.count({})],
    admins: [distinct(src('admins'), (d) => normalizeEmail(d.email)), await prisma.admin.count({})],
    subscribers: [distinct(src('subscribers'), (d) => normalizeEmail(d.email)), await prisma.subscriber.count({})],
  };
  for (const [name, [want, got]] of Object.entries(expect)) {
    add(got >= want ? 'ok' : 'error', 'count', `${name}: source ${want} distinct, database ${got}`);
  }

  // 2. spot-check manufacturers field by field
  const dbManufacturers = await prisma.manufacturer.findMany({});
  const byKey = new Map(dbManufacturers.map((m) => [m.companyKey, m]));
  let compared = 0;
  const comparedKeys = new Set();
  for (const d of src('manufacturer')) {
    const key = normalizeKey(d.company);
    // Mirror the importer: nameless docs and later duplicates of a company were deliberately not imported.
    if (!key || comparedKeys.has(key)) continue;
    comparedKeys.add(key);
    const m = byKey.get(key);
    if (!m) { add('error', 'manufacturer', `missing in database: ${d.company}`); continue; }
    compared += 1;
    if ((toStr(d.province) ?? '') !== (m.province ?? '')) add('warn', 'manufacturer', `${d.company}: province differs`);
    for (const [legacy, field] of Object.entries(PRODUCT_SECTIONS)) {
      const want = Array.isArray(d[legacy]) ? d[legacy].length : 0;
      if (want !== (m[field]?.length ?? 0)) add('error', 'products', `${d.company}: ${legacy} has ${want} in source but ${m[field]?.length ?? 0} in database`);
    }
    const wantReviews = Array.isArray(d.reviews) ? d.reviews.filter((r) => r?.comment).length : 0;
    if (wantReviews !== m.reviewCount) add('error', 'reviews', `${d.company}: ${wantReviews} reviews in source, reviewCount=${m.reviewCount}`);
  }
  add('ok', 'manufacturer', `${compared} manufacturers compared field by field`);

  // 3. references
  const ids = new Set(dbManufacturers.map((m) => m.id));
  for (const model of ['countrySetting', 'currencySetting', 'paymentSetting', 'deliverySetting']) {
    for (const row of await prisma[model].findMany({})) {
      if (!ids.has(row.manufacturerId)) add('error', 'reference', `${model} ${row.id} points at a missing manufacturer`);
    }
  }
  for (const r of await prisma.review.findMany({})) {
    if (!ids.has(r.manufacturerId)) add('error', 'reference', `review ${r.id} points at a missing manufacturer`);
  }
  for (const m of dbManufacturers) {
    const tagged = m.manufacturerType?.length ?? 0;
    if (tagged === 0) add('warn', 'reference', `${m.company}: no manufacturer type`);
  }

  // 4. duplicates (these block adding unique constraints later)
  const seen = new Map();
  for (const m of dbManufacturers) seen.set(m.companyKey, (seen.get(m.companyKey) ?? 0) + 1);
  for (const [k, n] of seen) if (n > 1) add('error', 'duplicate', `${n} manufacturers share the company key "${k}"`);

  // 5. coordinates
  for (const m of dbManufacturers) {
    if (m.latitude == null || m.longitude == null) add('warn', 'coordinates', `${m.company}: no coordinates (not shown on the map)`);
  }

  // 6. media URLs (optional: needs network)
  if (checkUrls) {
    const urls = new Set();
    for (const m of dbManufacturers) {
      for (const u of [m.logo, m.logoSmall, ...(m.gallery ?? [])]) if (u) urls.add(u);
      for (const f of Object.values(PRODUCT_SECTIONS)) for (const p of m[f] ?? []) for (const u of [p.image, ...(p.images ?? [])]) if (u) urls.add(u);
    }
    let bad = 0;
    for (const u of urls) {
      try {
        const res = await fetchImpl(u, { method: 'HEAD' });
        if (!res.ok) { bad += 1; add('error', 'url', `${res.status} ${u}`); }
      } catch (e) { bad += 1; add('error', 'url', `unreachable ${u}`); }
    }
    add(bad ? 'error' : 'ok', 'url', `${urls.size} media URLs checked, ${bad} broken`);
  }

  return { ok: !findings.some((f) => f.level === 'error'), findings };
}
