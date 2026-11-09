import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/config/prisma.js';
import { auditMedia, explain, probe } from '../src/migration/media.js';

const CL = 'https://res.cloudinary.com/demo/image/upload';
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const respond = (status, { type = 'image/png', headers = {}, body = png } = {}) =>
  new Response(status === 200 ? body : null, { status, headers: { 'content-type': type, ...headers } });

const seed = () => prisma.manufacturer.create({
  data: {
    company: 'Caffe Uno', logo: `${CL}/v1/ok.png`, logoSmall: `${CL}/v1/ok.png`,
    gallery: [`${CL}/v1/gone.jpg`, `${CL}/v1/ok2.png`],
    manufacturerType: [{ typeName: 'Machine', typeImage: `${CL}/v1/type.png`, icon: `${CL}/v1/icon.svg` }],
    coffeeBeans: [{ productId: 'c1', name: 'Roast', price: 1, currency: '€', image: `${CL}/v1/ok2.png`, images: [''], visibility: true }],
    products: [{ productId: 'p1', name: 'Beans', price: 1, currency: '€', image: 'https://shop.example.it/a.jpg', images: [`${CL}/v1/ok.png`], visibility: true }],
  },
});

const fetchImpl = vi.fn(async (url) => {
  if (url.includes('gone')) return respond(404, { headers: { 'x-cld-error': 'Resource not found' } });
  if (url.includes('icon.svg')) return respond(200, { type: 'image/svg+xml' });
  if (url.includes('shop.example.it')) return respond(200, { type: 'image/jpeg' });
  return respond(200);
});

describe('media audit', () => {
  beforeEach(() => { fetchImpl.mockClear(); }); // braces: a returned function would be run as a cleanup hook

  it('reports every image reference and why the broken ones fail, changing nothing', async () => {
    const m = await seed();
    const { summary, rows } = await auditMedia({ prisma, fetchImpl });
    expect(summary).toMatchObject({ references: 9, distinctUrls: 6, broken: 1 });
    expect(summary.byReason).toEqual({ CLOUDINARY: 1 });
    const bad = rows.find((r) => !r.ok);
    expect(bad.label).toBe('Caffe Uno › gallery #1');
    expect(bad.why.text).toMatch(/Resource not found/);
    expect((await prisma.manufacturer.findUnique({ where: { id: m.id } })).logo).toBe(`${CL}/v1/ok.png`);
  });

  it('copies working Cloudinary images to R2 and rewrites every reference, leaving the rest alone', async () => {
    const m = await seed();
    const put = vi.fn(async () => {});
    const storage = { publicBase: 'https://media.italiancoffee.co.uk/', keyPrefix: 'italiancoffee', put };
    const { summary } = await auditMedia({ prisma, fetchImpl, apply: true, storage });
    expect(summary.copiedToR2).toBe(3); // ok.png, ok2.png, type.png (svg kept, gone.jpg broken, shop image is third-party)
    const after = await prisma.manufacturer.findUnique({ where: { id: m.id } });
    expect(after.logo).toMatch(/^https:\/\/media\.italiancoffee\.co\.uk\/italiancoffee\/legacy\/[0-9a-f]{20}\.png$/);
    expect(after.logoSmall).toBe(after.logo);
    expect(after.products[0].images[0]).toBe(after.logo);
    expect(after.products[0].image).toBe('https://shop.example.it/a.jpg');
    expect(after.coffeeBeans[0].image).toMatch(/media\.italiancoffee\.co\.uk/); // every product section, not just `products`
    expect(after.gallery[0]).toBe(`${CL}/v1/gone.jpg`);
    expect(after.gallery[1]).toMatch(/media\.italiancoffee\.co\.uk/);
    expect(after.manufacturerType[0].typeImage).toMatch(/media\.italiancoffee\.co\.uk/);
    expect(after.manufacturerType[0].icon).toBe(`${CL}/v1/icon.svg`);
    expect(put).toHaveBeenCalledWith(expect.stringMatching(/^italiancoffee\/legacy\//), expect.any(Buffer), 'image/png');
  });

  it('is safe to re-run: already-copied images are left as they are', async () => {
    await seed();
    const storage = { publicBase: 'https://media.italiancoffee.co.uk', keyPrefix: 'italiancoffee', put: vi.fn(async () => {}) };
    await auditMedia({ prisma, fetchImpl, apply: true, storage });
    storage.put.mockClear();
    const again = await auditMedia({ prisma, fetchImpl: async () => respond(200), apply: true, storage });
    expect(again.summary.copiedToR2).toBe(1); // only the gallery image that was broken the first time; everything else already lives on R2
    expect(again.summary.ownHostAlreadyServing).toBeGreaterThan(0);
  });
});

describe('failure explanations', () => {
  it('names the cause in plain words', async () => {
    expect(explain({ error: 'ENOTFOUND getaddrinfo' }).code).toBe('DNS');
    expect(explain({ status: 404 }).code).toBe('NOT_FOUND');
    expect(explain({ status: 403 }).code).toBe('FORBIDDEN');
    expect(explain({ status: 200, contentType: 'text/html' }).code).toBe('NOT_IMAGE');
    expect(explain({ status: 401, cldError: 'Customer is marked as untrusted' }).text).toMatch(/untrusted/);
    const r = await probe('https://x.test/a.png', { fetchImpl: async () => { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; } });
    expect(r.ok).toBe(false);
    expect(r.why.code).toBe('DNS');
  });
});
