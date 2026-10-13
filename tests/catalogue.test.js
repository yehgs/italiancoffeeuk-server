import { beforeEach, describe, expect, it } from 'vitest';
import { login, prisma, request, app, seedAdmin, seedCustomer } from './helpers/app.js';

let admin;
beforeEach(async () => {
  await seedAdmin();
  admin = await login('admin', { email: 'root@example.com', password: 'Sup3rSecretPass' });
});

const base = {
  company: 'Illy Caffè', province: 'Trieste', latitude: 45.65, longitude: 13.77,
  'COFFEE BEANS': [{ name: 'Classico', price: '12.50', currency: '€', images: [''], videos: [''] }],
  products: [{ name: 'Machine', price: 100, currency: '€', visibility: true }],
};

describe('manufacturers', () => {
  it('creates a manufacturer and returns the legacy shape', async () => {
    const res = await admin.post('/api/manufacturers').send(base);
    expect(res.status).toBe(201);
    const m = res.body.data;
    expect(m.company).toBe('Illy Caffè');
    expect(m.position).toEqual([45.65, 13.77]);
    expect(m['COFFEE BEANS'][0].price).toBe(12.5); // string price became a number
    expect(m['COFFEE BEANS'][0].productId).toBeTruthy();
    expect(m.createdBy).toBe('Root Admin');
  });

  it('requires coordinates and a unique company name', async () => {
    const noCoords = await admin.post('/api/manufacturers').send({ company: 'X' });
    expect(noCoords.status).toBe(400);
    expect(noCoords.body.error.message).toMatch(/Longitude and Latitude/);
    await admin.post('/api/manufacturers').send(base);
    const dup = await admin.post('/api/manufacturers').send({ ...base, company: '  illy   caffè ' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('COMPANY_EXISTS');
  });

  it('accepts legacy `position` and fixes longitude-first pairs', async () => {
    const res = await admin.post('/api/manufacturers').send({ company: 'Swapped', position: [120.5, 40.1] });
    expect(res.status).toBe(201);
    expect(res.body.data.latitude).toBe(40.1);
    expect(res.body.data.longitude).toBe(120.5);
    expect(res.body.meta.warnings.join()).toMatch(/swapped/);
  });

  it('lists publicly with pagination meta, without reviews payloads', async () => {
    await admin.post('/api/manufacturers').send(base);
    await admin.post('/api/manufacturers').send({ ...base, company: 'Lavazza' });
    const res = await request(app).get('/api/manufacturers?limit=1&page=2');
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ total: 2, page: 2, limit: 1, pages: 2 });
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).not.toHaveProperty('reviews');
    expect(res.body.data[0]).not.toHaveProperty('ratingSum');
  });

  it('caps page size', async () => {
    expect((await request(app).get('/api/manufacturers?limit=100000')).status).toBe(400);
  });

  it('PATCH only changes the fields sent and never touches immutable audit fields', async () => {
    const created = (await admin.post('/api/manufacturers').send(base)).body.data;
    const res = await admin.patch(`/api/manufacturers/${created.id}`).send({ history: 'Since 1933', createdBy: 'hacker', createdAt: '2000-01-01' });
    expect(res.status).toBe(200);
    expect(res.body.data.history).toBe('Since 1933');
    expect(res.body.data.createdBy).toBe('Root Admin');
    expect(res.body.data.province).toBe('Trieste');
    expect(res.body.data['COFFEE BEANS']).toHaveLength(1);
    expect((await admin.patch(`/api/manufacturers/${created.id}`).send({})).status).toBe(400);
  });

  it('rejects malformed ids with 400 and unknown ids with 404', async () => {
    expect((await request(app).get('/api/manufacturers/not-an-id')).status).toBe(400);
    expect((await request(app).get('/api/manufacturers/' + 'a'.repeat(24))).status).toBe(404);
  });

  it('toggles section visibility and a single product by stable id', async () => {
    const created = (await admin.post('/api/manufacturers').send(base)).body.data;
    const v = await admin.patch(`/api/manufacturers/${created.id}/visibility`).send({ field: 'coffeeBeansVisibility', value: false });
    expect(v.body.data.coffeeBeansVisibility).toBe(false);
    expect((await admin.patch(`/api/manufacturers/${created.id}/visibility`).send({ field: 'company', value: false })).status).toBe(400);

    const pid = created['COFFEE BEANS'][0].productId;
    const p = await admin.patch(`/api/manufacturers/${created.id}/products/${pid}/visibility`).send({ section: 'COFFEE BEANS', visible: false });
    expect(p.body.data['COFFEE BEANS'][0].visibility).toBe(false);
    const missing = await admin.patch(`/api/manufacturers/${created.id}/products/nope/visibility`).send({ section: 'COFFEE BEANS', visible: true });
    expect(missing.status).toBe(404);
  });

  it('serialises concurrent product edits instead of losing one', async () => {
    const created = (await admin.post('/api/manufacturers').send({
      ...base,
      'COFFEE BEANS': [{ name: 'A', price: 1 }, { name: 'B', price: 2 }],
    })).body.data;
    const [a, b] = created['COFFEE BEANS'].map((p) => p.productId);
    await Promise.all([
      admin.patch(`/api/manufacturers/${created.id}/products/${a}/visibility`).send({ section: 'COFFEE BEANS', visible: false }),
      admin.patch(`/api/manufacturers/${created.id}/products/${b}/visibility`).send({ section: 'COFFEE BEANS', visible: false }),
    ]);
    const final = (await request(app).get(`/api/manufacturers/${created.id}`)).body.data;
    expect(final['COFFEE BEANS'].map((p) => p.visibility)).toEqual([false, false]);
  });

  it('delete removes the manufacturer, its reviews and settings', async () => {
    const m = (await admin.post('/api/manufacturers').send(base)).body.data;
    await admin.post('/api/countries/items').send({ manufacturerId: m.id, item: 'Italy' });
    expect((await admin.delete(`/api/manufacturers/${m.id}`)).status).toBe(204);
    expect((await request(app).get(`/api/manufacturers/${m.id}`)).status).toBe(404);
    expect(prisma.countrySetting.__rows()).toHaveLength(0);
  });
});

describe('reviews', () => {
  it('requires a customer, validates input and updates stats atomically', async () => {
    const m = (await admin.post('/api/manufacturers').send(base)).body.data;
    expect((await request(app).post(`/api/manufacturers/${m.id}/reviews`).send({ comment: 'x', rate: 5 })).status).toBe(401);

    await seedCustomer();
    const c = await login('user', { email: 'jane@example.com', password: 'Passw0rdOK' });
    expect((await c.post(`/api/manufacturers/${m.id}/reviews`).send({ comment: '', rate: 5 })).status).toBe(400);
    expect((await c.post(`/api/manufacturers/${m.id}/reviews`).send({ comment: 'ok', rate: 9 })).status).toBe(400);
    await c.post(`/api/manufacturers/${m.id}/reviews`).send({ comment: 'Great', rate: 5 });
    await c.post(`/api/manufacturers/${m.id}/reviews`).send({ comment: 'Fine', rate: 3 });
    await c.post(`/api/manufacturers/${m.id}/reviews`).send({ comment: 'No stars', rate: 0 });

    const detail = (await request(app).get(`/api/manufacturers/${m.id}`)).body.data;
    expect(detail.reviewCount).toBe(3);
    expect(detail.averageRating).toBe(4); // (5+3)/2, the unrated one is excluded
    expect(detail.reviews).toHaveLength(3);
    expect(detail.reviews[0]).toMatchObject({ name: 'Jane Doe' });
    const page = await request(app).get(`/api/manufacturers/${m.id}/reviews?limit=2`);
    expect(page.body.meta.total).toBe(3);
  });
});

describe('filter lists', () => {
  it.each([
    ['tags', { tag: 'Espresso' }, 'tag'],
    ['categories', { category: 'Beans' }, 'category'],
    ['regions', { region: 'Lazio' }, 'region'],
  ])('%s: public read, admin CRUD, duplicate guard', async (path, body, field) => {
    const created = await admin.post(`/api/${path}`).send(body);
    expect(created.status).toBe(201);
    expect(created.body.data[field]).toBe(body[field]);
    const dup = await admin.post(`/api/${path}`).send({ [field]: `  ${body[field].toUpperCase()} ` });
    expect(dup.status).toBe(409);
    expect((await request(app).get(`/api/${path}`)).body.data).toHaveLength(1);
    const id = created.body.data.id;
    const edited = await admin.patch(`/api/${path}/${id}`).send({ [field]: 'Edited' });
    expect(edited.body.data[field]).toBe('Edited');
    expect((await request(app).post(`/api/${path}`).send(body)).status).toBe(401);
    expect((await admin.delete(`/api/${path}/${id}`)).status).toBe(204);
    expect((await admin.delete(`/api/${path}/${id}`)).status).toBe(404);
  });

  it('manufacturer types keep the legacy wrapper and flat fields', async () => {
    const res = await admin.post('/api/manufacturer-types').send({ typeName: 'Roaster', typeImage: 'https://res.cloudinary.com/x/y.png' });
    expect(res.status).toBe(201);
    expect(res.body.data.manufacturerType).toEqual([{ typeName: 'Roaster', typeImage: 'https://res.cloudinary.com/x/y.png' }]);
    expect(res.body.data.typeName).toBe('Roaster');
    expect((await admin.post('/api/manufacturer-types').send({ typeName: 'roaster' })).status).toBe(409);
    expect((await admin.post('/api/manufacturer-types').send({ typeName: 'Bad', typeImage: 'javascript:alert(1)' })).status).toBe(400);
  });
});

describe('subscribers', () => {
  it('normalises, blocks duplicates via the unique index, and is admin-readable only', async () => {
    const a = await request(app).post('/api/subscribers').send({ email: 'Fan@Example.com ' });
    expect(a.status).toBe(201);
    expect(a.body.data.email).toBe('fan@example.com');
    const b = await request(app).post('/api/subscribers').send({ email: 'fan@example.com' });
    expect(b.status).toBe(409);
    expect(b.body.error.message).toBe('Email is already subscribed');
    expect((await request(app).post('/api/subscribers').send({ email: 'not-an-email' })).status).toBe(400);
    expect((await request(app).get('/api/subscribers')).status).toBe(401);
    const list = await admin.get('/api/subscribers');
    expect(list.body.meta.total).toBe(1);
    expect((await admin.delete(`/api/subscribers/${a.body.data.id}`)).status).toBe(204);
  });
});
