import crypto from 'node:crypto';

/**
 * Audit (and optionally re-host) every image URL stored in the database.
 * Pure of side effects except through the injected `prisma`, `fetchImpl` and `putObject`, so it is testable.
 */

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
// Product lists a manufacturer keeps (the storefront tabs).
const PRODUCT_SECTIONS = ['products', 'coffeeBeans', 'compatibleCapsules', 'esePods', 'grindedCoffee'];
const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u.trim());
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };

/** Every image reference we store: where it lives and how to put a new URL back. */
export async function collectRefs(prisma) {
  const refs = [];
  const add = (where, url, label) => { if (isHttp(url)) refs.push({ where, url: url.trim(), label }); };
  const manufacturers = await prisma.manufacturer.findMany({});
  for (const m of manufacturers) {
    const name = m.company || m.id;
    add({ id: m.id, path: ['logo'] }, m.logo, `${name} › logo`);
    add({ id: m.id, path: ['logoSmall'] }, m.logoSmall, `${name} › small logo`);
    (m.gallery ?? []).forEach((u, i) => add({ id: m.id, path: ['gallery', i] }, u, `${name} › gallery #${i + 1}`));
    (m.manufacturerType ?? []).forEach((t, i) => {
      add({ id: m.id, path: ['manufacturerType', i, 'typeImage'] }, t.typeImage, `${name} › type image`);
      add({ id: m.id, path: ['manufacturerType', i, 'icon'] }, t.icon, `${name} › type icon`);
    });
    for (const section of PRODUCT_SECTIONS) {
      (m[section] ?? []).forEach((p, i) => {
        add({ id: m.id, path: [section, i, 'image'] }, p.image, `${name} › ${section} “${p.name}” image`);
        (p.images ?? []).forEach((u, j) => add({ id: m.id, path: [section, i, 'images', j] }, u, `${name} › ${section} “${p.name}” photo #${j + 1}`));
      });
    }
  }
  for (const t of await prisma.manufacturerType.findMany({})) {
    add({ model: 'manufacturerType', id: t.id, path: ['typeImage'] }, t.typeImage, `Manufacturer type “${t.typeName}” › image`);
  }
  return refs;
}

/** Why a URL does not work, in plain words. */
export function explain({ status, cldError, contentType, error }) {
  if (error) {
    if (/ENOTFOUND|EAI_AGAIN/.test(error)) return { code: 'DNS', text: 'This computer cannot resolve the image host (no internet, DNS or the host no longer exists).' };
    if (/timeout|timed out|abort/i.test(error)) return { code: 'TIMEOUT', text: 'The image host did not answer in time.' };
    return { code: 'NETWORK', text: `Could not connect: ${error}` };
  }
  if (cldError) return { code: 'CLOUDINARY', text: `Cloudinary refused it: “${cldError}”` };
  if (status === 404 || status === 410) return { code: 'NOT_FOUND', text: 'The file no longer exists at that address (deleted, or the account was closed).' };
  if (status === 401 || status === 403) return { code: 'FORBIDDEN', text: `The host refuses to serve it (HTTP ${status}). Hotlink protection, a restricted/suspended account, or private media.` };
  if (status >= 500) return { code: 'SERVER', text: `The image host is failing (HTTP ${status}).` };
  if (status && status >= 400) return { code: 'HTTP', text: `HTTP ${status}.` };
  if (contentType && !/^image\//i.test(contentType)) return { code: 'NOT_IMAGE', text: `The address returns ${contentType}, not an image.` };
  return { code: 'UNKNOWN', text: 'Unknown problem.' };
}

export async function probe(url, { fetchImpl = fetch, timeoutMs = 15000, withBody = false } = {}) {
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'image/*,*/*;q=0.5' } });
    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const cldError = res.headers.get('x-cld-error') || undefined;
    const ok = res.ok && /^image\//.test(contentType);
    const out = { ok, status: res.status, contentType, cldError };
    if (ok && withBody) out.body = Buffer.from(await res.arrayBuffer());
    else await res.body?.cancel?.().catch(() => {});
    if (!ok) out.why = explain(out);
    return out;
  } catch (e) {
    const error = `${e?.cause?.code || ''} ${e?.message || e}`.trim();
    return { ok: false, error, why: explain({ error }) };
  }
}

const mapLimit = async (items, n, fn) => {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
};

export const r2Key = (prefix, url, ext) => `${prefix}/legacy/${crypto.createHash('sha1').update(url).digest('hex').slice(0, 20)}.${ext}`;

/**
 * @param {object} o
 * @param {string[]} o.legacyHosts hosts whose files we copy to R2 (default Cloudinary)
 * @param {boolean} o.apply copy working legacy images to R2 and rewrite the database
 * @param {{publicBase:string, keyPrefix:string, put:(key,body,contentType)=>Promise<void>}} [o.storage]
 */
export async function auditMedia({ prisma, fetchImpl = fetch, legacyHosts = ['res.cloudinary.com'], apply = false, storage, concurrency = 6, log = () => {} }) {
  const refs = await collectRefs(prisma);
  const ownHost = storage?.publicBase ? hostOf(storage.publicBase) : '';
  const byUrl = new Map();
  for (const r of refs) { if (!byUrl.has(r.url)) byUrl.set(r.url, []); byUrl.get(r.url).push(r); }
  const urls = [...byUrl.keys()];
  const results = new Map();
  let done = 0;

  await mapLimit(urls, concurrency, async (url) => {
    const host = hostOf(url);
    const legacy = legacyHosts.includes(host);
    const isSvg = /\.svg(\?|$)/i.test(url);
    const p = await probe(url, { fetchImpl, withBody: apply && legacy && !isSvg });
    const res = { url, host, legacy, ...p, newUrl: undefined, action: 'none' };
    if (p.ok && apply && legacy) {
      if (isSvg || p.contentType === 'image/svg+xml') res.action = 'kept (SVG is not allowed on the media domain)';
      else if (!storage) res.action = 'skipped (R2 is not configured)';
      else if (!EXT[p.contentType]) res.action = `skipped (unsupported type ${p.contentType})`;
      else {
        const key = r2Key(storage.keyPrefix, url, EXT[p.contentType]);
        try {
          await storage.put(key, p.body, p.contentType);
          res.newUrl = `${storage.publicBase.replace(/\/+$/, '')}/${key}`;
          res.action = 'copied to R2';
        } catch (e) { res.action = `copy failed: ${e.message}`; }
      }
    }
    delete res.body;
    results.set(url, res);
    log(++done, urls.length, res);
  });

  let updated = 0;
  if (apply) {
    const changes = refs.filter((r) => results.get(r.url)?.newUrl);
    const byDoc = new Map();
    for (const r of changes) { const k = `${r.where.model || 'manufacturer'}:${r.where.id}`; (byDoc.get(k) ?? byDoc.set(k, []).get(k)).push(r); }
    for (const [k, list] of byDoc) {
      const [model, id] = k.split(':');
      const doc = await prisma[model].findUnique({ where: { id } });
      const data = {};
      for (const r of list) {
        const [top, ...rest] = r.where.path;
        data[top] ??= structuredClone(doc[top]);
        let target = data;
        let key = top;
        for (const seg of rest) { target = target[key]; key = seg; }
        target[key] = results.get(r.url).newUrl;
      }
      const write = {};
      for (const [top, value] of Object.entries(data)) write[top] = Array.isArray(value) ? { set: value } : value;
      await prisma[model].update({ where: { id }, data: write });
      updated += 1;
    }
  }

  const rows = refs.map((r) => ({ ...r, ...results.get(r.url) }));
  const summary = {
    references: refs.length,
    distinctUrls: urls.length,
    working: [...results.values()].filter((r) => r.ok).length,
    broken: [...results.values()].filter((r) => !r.ok).length,
    byReason: [...results.values()].filter((r) => !r.ok).reduce((a, r) => ({ ...a, [r.why.code]: (a[r.why.code] || 0) + 1 }), {}),
    ownHostAlreadyServing: ownHost ? refs.filter((r) => hostOf(r.url) === ownHost).length : 0,
    copiedToR2: [...results.values()].filter((r) => r.newUrl).length,
    documentsUpdated: updated,
  };
  return { summary, rows };
}
