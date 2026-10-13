import crypto from 'node:crypto';
import { normalizeKey } from './ids.js';

/**
 * Firestore documents were schemaless and their types drifted (a field can be
 * "" in one document and an array in another). This module is the single place
 * where legacy shapes are coerced to the strict Prisma shapes and back.
 * It is used by both the REST API and the Firestore import script.
 */

/** API/legacy section key -> Prisma field name */
export const PRODUCT_SECTIONS = {
  products: 'products',
  'COFFEE BEANS': 'coffeeBeans',
  'COMPATIBLE CAPSULES': 'compatibleCapsules',
  'ESE PODS': 'esePods',
  'GRINDED COFFEE': 'grindedCoffee',
};
export const SECTION_FIELDS = Object.values(PRODUCT_SECTIONS);

export const VISIBILITY_FIELDS = [
  'visibility',
  'coffeeBeansVisibility',
  'compatibleCapsuleVisibility',
  'esePodsVisibility',
  'grindedCoffeeVisibility',
];

// ───────────────────────── coercion helpers ─────────────────────────

const isNil = (v) => v === undefined || v === null;

export const toStr = (v) => {
  if (isNil(v)) return undefined;
  if (Array.isArray(v)) return v.map(String).join(', ');
  if (typeof v === 'object') return undefined;
  const s = String(v);
  return s;
};

/** Drops script-capable schemes from values that end up in <img src>/<video src>. */
const SCRIPT_SCHEME = /^\s*(javascript|vbscript|data:text)/i;
export const toUrl = (v) => {
  const s = toStr(v);
  return s !== undefined && SCRIPT_SCHEME.test(s) ? undefined : s;
};
export const toUrlArray = (v) => toStrArray(v).filter((x) => !SCRIPT_SCHEME.test(x));

export const toNum = (v, fallback) => {
  if (isNil(v) || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : fallback;
};

export const toBool = (v, fallback) => {
  if (typeof v === 'boolean') return v;
  if (isNil(v) || v === '') return fallback;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', 'yes', '1', 'on'].includes(s)) return true;
    if (['false', 'no', '0', 'off'].includes(s)) return false;
    return fallback;
  }
  if (typeof v === 'number') return v !== 0;
  return fallback;
};

export const toStrArray = (v) => {
  if (isNil(v) || v === '') return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .map((x) => (isNil(x) ? undefined : typeof x === 'object' ? (x.name ?? x.label ?? x.value) : x))
    .filter((x) => !isNil(x))
    .map(String);
};

/** Firestore Timestamp ({seconds, nanoseconds}), ISO string, ms number or Date -> Date | undefined */
export function toDate(v) {
  if (isNil(v) || v === '') return undefined;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v;
  if (typeof v === 'object' && ('seconds' in v || '_seconds' in v)) {
    const s = v.seconds ?? v._seconds;
    const n = v.nanoseconds ?? v._nanoseconds ?? 0;
    return new Date(Number(s) * 1000 + Math.floor(Number(n) / 1e6));
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// ───────────────────────── product ─────────────────────────

export function normalizeProduct(raw, { keepId = true, seed } = {}) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const images = toUrlArray(p.images);
  return {
    productId: (keepId && toStr(p.productId)) || (seed ? crypto.createHash('sha1').update(`${seed}|${toStr(p.name) ?? ''}`).digest('hex').slice(0, 24) : crypto.randomUUID()),
    name: toStr(p.name) ?? '',
    price: toNum(p.price, 0),
    currency: toStr(p.currency) || '€',
    rate: toNum(p.rate, undefined),
    image: toUrl(p.image),
    images,
    videos: toUrlArray(p.videos),
    description: toStr(p.description),
    quantity: toStr(p.quantity),
    intensity: toStr(p.intensity),
    weight: toStr(p.weight),
    profile: toStr(p.profile),
    origin: toStr(p.origin),
    preparation: toStr(p.preparation),
    roast: toStr(p.roast),
    area: toStr(p.area),
    bestBefore: toStr(p.bestBefore),
    roastingDate: toStr(p.roastingDate),
    visibility: toBool(p.visibility, true),
  };
}

// Deterministic fallback ids (section + position + name) keep re-imports idempotent.
const normalizeProducts = (v, section = '') => (Array.isArray(v) ? v : []).map((p, i) => normalizeProduct(p, { seed: `${section}#${i}` }));

// ───────────────────────── composite helpers ─────────────────────────

function normalizeGlobal(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((g) => g && typeof g === 'object')
    .map((g) => ({
      name: toStr(g.name),
      value: toStr(g.value),
      label: toStr(g.label),
      latitude: toNum(g.latitude, undefined),
      longitude: toNum(g.longitude, undefined),
    }));
}

function normalizeSocials(v) {
  // Legacy: array of {type, link}; UpdateData's initial state was {facebook: ""}.
  if (Array.isArray(v)) {
    return v
      .filter((s) => s && typeof s === 'object' && (s.type || s.link))
      .map((s) => ({ type: toStr(s.type) ?? '', link: toStr(s.link) ?? '' }));
  }
  if (v && typeof v === 'object') {
    return Object.entries(v)
      .filter(([, link]) => link)
      .map(([type, link]) => ({ type, link: String(link) }));
  }
  return [];
}

function normalizeTypeRefs(v) {
  const arr = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
  return arr
    .filter((t) => t && typeof t === 'object' && t.typeName)
    .map((t) => ({ typeName: String(t.typeName), typeImage: toStr(t.typeImage), icon: toStr(t.icon) }));
}

// ───────────────────────── position ─────────────────────────

/**
 * Legacy `position` was `[a, b]`, rendered by the old Leaflet map as `[lat, lng]`
 * (so a === latitude). The admin form mislabelled the first input "Longitude".
 * If `a` cannot be a latitude (|a| > 90) but `b` can, the pair was entered
 * swapped, so swap it back.
 */
export function coordsFromLegacyPosition(pos) {
  if (!Array.isArray(pos) || pos.length < 2) return { warnings: [] };
  let lat = toNum(pos[0]);
  let lng = toNum(pos[1]);
  const warnings = [];
  if (lat === undefined || lng === undefined) return { warnings: ['position not numeric'] };
  if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) {
    [lat, lng] = [lng, lat];
    warnings.push('position looked longitude-first; swapped to [lat, lng]');
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return { warnings: ['position out of range; ignored'] };
  return { latitude: lat, longitude: lng, warnings };
}

// ───────────────────────── input (legacy/body -> Prisma) ─────────────────────────

/**
 * Accepts the field names the existing React forms send and returns
 * `{ data, warnings }` where data is a partial Prisma Manufacturer.
 * Only keys present in `raw` are emitted so PATCH never wipes fields.
 * Unknown keys are dropped (the old forms wrote UI state keys like `rate`,
 * `terms`, `privacy` into Firestore) and reported in `warnings`.
 */
export function manufacturerInputToData(raw = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(raw, k);
  const warnings = [];
  const data = {};
  const known = new Set();

  const str = (legacy, field) => {
    known.add(legacy);
    if (has(legacy)) {
      const v = toStr(raw[legacy]);
      data[field] = v === undefined ? null : v;
    }
  };
  const bool = (legacy, field) => {
    known.add(legacy);
    if (has(legacy)) {
      const v = toBool(raw[legacy], undefined);
      if (v === undefined) warnings.push(`${legacy}: not boolean, ignored`);
      else data[field] = v;
    }
  };
  const arr = (legacy, field, conv = toStrArray) => {
    known.add(legacy);
    if (has(legacy)) data[field] = conv(raw[legacy]);
  };
  const url = (legacy, field) => {
    known.add(legacy);
    if (has(legacy)) {
      const v = toUrl(raw[legacy]);
      data[field] = v === undefined ? null : v;
    }
  };

  str('company', 'company');
  if (has('company')) data.companyKey = normalizeKey(data.company);
  for (const [legacy, field] of [
    ['province', 'province'], ['category', 'category'], ['region', 'region'],
    ['manufacturerCountry', 'manufacturerCountry'], ['address', 'address'],
    ['website', 'website'], ['email', 'email'], ['contact', 'contact'],
    ['youtube_link', 'youtubeLink'],
    ['whatsapp_link', 'whatsappLink'], ['profit_project', 'profitProject'],
    ['delivery_link', 'deliveryLink'], ['processing', 'processing'], ['year', 'year'],
    ['history', 'history'], ['shipping', 'shipping'], ['newsletter', 'newsletter'],
    ['legal', 'legal'], ['team', 'team'], ['faq', 'faq'], ['cookies', 'cookies'],
    ['privacy_policy', 'privacyPolicy'], ['terms_condition', 'termsCondition'],
    ['award_winners', 'awardWinners'], ['createdBy', 'createdBy'],
  ]) str(legacy, field);

  url('logo', 'logo');
  url('logo_small', 'logoSmall');

  for (const [legacy, field] of [
    ['academy', 'academy'], ['blog', 'blog'], ['sustainability', 'sustainability'],
    ['sales_online', 'salesOnline'], ['visibility', 'visibility'],
    ['coffeeBeansVisibility', 'coffeeBeansVisibility'],
    ['compatibleCapsuleVisibility', 'compatibleCapsuleVisibility'],
    ['esePodsVisibility', 'esePodsVisibility'],
    ['grindedCoffeeVisibility', 'grindedCoffeeVisibility'],
  ]) bool(legacy, field);

  arr('gallery', 'gallery', toUrlArray);
  for (const [legacy, field] of [
    ['range_products', 'rangeProducts'],
    ['merchandise', 'merchandise'], ['other_brands', 'otherBrands'],
    ['not_only_coffee', 'notOnlyCoffee'], ['intl_certification', 'intlCertification'],
  ]) arr(legacy, field);

  known.add('company_rate');
  if (has('company_rate')) {
    const n = toNum(raw.company_rate, 0);
    data.companyRate = Math.min(5, Math.max(0, n));
  }

  known.add('global');
  if (has('global')) data.global = normalizeGlobal(raw.global);
  known.add('socials');
  if (has('socials')) data.socials = normalizeSocials(raw.socials);
  known.add('manufacturerType');
  if (has('manufacturerType')) data.manufacturerType = normalizeTypeRefs(raw.manufacturerType);

  for (const [legacy, field] of Object.entries(PRODUCT_SECTIONS)) {
    known.add(legacy);
    if (has(legacy)) data[field] = normalizeProducts(raw[legacy], field);
  }

  // Coordinates: explicit latitude/longitude win; legacy `position` is accepted.
  known.add('latitude'); known.add('longitude'); known.add('position');
  if (has('latitude') || has('longitude')) {
    const lat = toNum(raw.latitude);
    const lng = toNum(raw.longitude);
    if (lat !== undefined && (lat < -90 || lat > 90)) warnings.push('latitude out of range');
    else if (has('latitude')) data.latitude = lat ?? null;
    if (lng !== undefined && (lng < -180 || lng > 180)) warnings.push('longitude out of range');
    else if (has('longitude')) data.longitude = lng ?? null;
  } else if (has('position')) {
    const c = coordsFromLegacyPosition(raw.position);
    warnings.push(...c.warnings);
    if (c.latitude !== undefined) {
      data.latitude = c.latitude;
      data.longitude = c.longitude;
    }
  }

  known.add('createdAt');
  if (has('createdAt')) {
    const d = toDate(raw.createdAt);
    if (d) data.createdAt = d;
  }

  const ignored = new Set(['id', 'reviews', 'reviewCount', 'averageRating', 'updatedAt', 'legacyFirebaseId']);
  for (const k of Object.keys(raw)) {
    if (!known.has(k) && !ignored.has(k)) warnings.push(`unknown field dropped: ${k}`);
  }
  return { data, warnings };
}

// ───────────────────────── output (Prisma -> legacy shape the UI reads) ─────────────────────────

const stripUndefined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

function productOut(p) {
  return stripUndefined({ ...p });
}

/**
 * Shape consumed by the existing React components (legacy key names kept).
 * `position` stays `[lat, lng]` for any component that still reads it.
 */
export function manufacturerToLegacy(m, { reviews } = {}) {
  if (!m) return m;
  const count = m.reviewCount ?? 0;
  const out = {
    id: m.id,
    company: m.company,
    province: m.province ?? '',
    category: m.category ?? undefined,
    region: m.region ?? undefined,
    manufacturerCountry: m.manufacturerCountry ?? '',
    address: m.address ?? '',
    website: m.website ?? '',
    email: m.email ?? '',
    contact: m.contact ?? '',
    logo: m.logo ?? '',
    logo_small: m.logoSmall ?? '',
    youtube_link: m.youtubeLink ?? '',
    whatsapp_link: m.whatsappLink ?? '',
    profit_project: m.profitProject ?? '',
    delivery_link: m.deliveryLink ?? '',
    processing: m.processing ?? '',
    year: m.year ?? '',
    history: m.history ?? '',
    shipping: m.shipping ?? '',
    newsletter: m.newsletter ?? '',
    legal: m.legal ?? '',
    team: m.team ?? '',
    faq: m.faq ?? '',
    cookies: m.cookies ?? '',
    privacy_policy: m.privacyPolicy ?? '',
    terms_condition: m.termsCondition ?? '',
    award_winners: m.awardWinners ?? '',
    intl_certification: m.intlCertification ?? [],
    createdBy: m.createdBy ?? '',
    company_rate: m.companyRate ?? 0,
    academy: m.academy,
    blog: m.blog,
    sustainability: m.sustainability,
    sales_online: m.salesOnline,
    visibility: m.visibility,
    coffeeBeansVisibility: m.coffeeBeansVisibility,
    compatibleCapsuleVisibility: m.compatibleCapsuleVisibility,
    esePodsVisibility: m.esePodsVisibility,
    grindedCoffeeVisibility: m.grindedCoffeeVisibility,
    latitude: m.latitude ?? null,
    longitude: m.longitude ?? null,
    position: m.latitude != null && m.longitude != null ? [m.latitude, m.longitude] : [],
    gallery: m.gallery ?? [],
    range_products: m.rangeProducts ?? [],
    merchandise: m.merchandise ?? [],
    other_brands: m.otherBrands ?? [],
    not_only_coffee: m.notOnlyCoffee ?? [],
    global: (m.global ?? []).map(stripUndefined),
    socials: m.socials ?? [],
    manufacturerType: (m.manufacturerType ?? []).map(stripUndefined),
    reviewCount: count,
    averageRating: (m.ratingCount ?? 0) > 0 ? Math.round((m.ratingSum / m.ratingCount) * 10) / 10 : 0,
    createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
    updatedAt: m.updatedAt instanceof Date ? m.updatedAt.toISOString() : m.updatedAt,
  };
  for (const [legacy, field] of Object.entries(PRODUCT_SECTIONS)) {
    out[legacy] = (m[field] ?? []).map(productOut);
  }
  if (reviews) out.reviews = reviews.map(reviewToLegacy);
  return out;
}

export function reviewToLegacy(r) {
  return {
    id: r.id,
    uid: r.userId ?? r.legacyUid ?? null,
    name: r.name,
    comment: r.comment,
    rate: r.rate,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
  };
}
