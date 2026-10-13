import { beforeEach, describe, expect, it } from 'vitest';
import { login, prisma, request, app, seedAdmin, seedCustomer } from './helpers/app.js';
import { resetEnvCache } from '../src/config/env.js';

let admin, mid;
beforeEach(async () => {
  await seedAdmin();
  admin = await login('admin', { email: 'root@example.com', password: 'Sup3rSecretPass' });
  const m = await admin.post('/api/manufacturers').send({
    company: 'Illy', latitude: 45, longitude: 13,
    'COFFEE BEANS': [{ name: 'Classico', price: 10, currency: '€' }],
    'ESE PODS': [{ name: 'Pods', price: 4, currency: '£' }],
    products: [{ name: 'Hidden', price: 5, currency: '€', visibility: false }],
  });
  mid = m.body.data;
});

describe('settings lists', () => {
  it('countries: create-or-append by company, dedupe case-insensitively, edit and delete', async () => {
    const first = await admin.post('/api/countries/items').send({ company: 'illy', item: 'Italy' });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ company: 'Illy', country: ['Italy'] });
    const second = await admin.post('/api/countries/items').send({ manufacturerId: mid.id, item: 'France' });
    expect(second.body.data.country).toEqual(['Italy', 'France']);
    expect((await admin.post('/api/countries/items').send({ manufacturerId: mid.id, item: ' ITALY ' })).status).toBe(409);

    const id = first.body.data.id;
    const edit = await admin.patch(`/api/countries/${id}/items`).send({ match: 'France', item: 'Spain' });
    expect(edit.body.data.country).toEqual(['Italy', 'Spain']);
    const del = await admin.delete(`/api/countries/${id}/items?match=Italy`);
    expect(del.body.data.country).toEqual(['Spain']);
    expect((await admin.delete(`/api/countries/${id}/items?match=Nope`)).status).toBe(404);

    const read = await request(app).get('/api/countries?company=ILLY');
    expect(read.body.data[0].country).toEqual(['Spain']);
    expect((await request(app).get('/api/countries?company=Unknown')).body.data).toEqual([]);
  });

  it('currencies: uppercases name, blocks same name or symbol, edits by name', async () => {
    const a = await admin.post('/api/currencies/items').send({ manufacturerId: mid.id, item: { name: 'dollar', symbol: '$', rate: '1.08' } });
    expect(a.body.data.currency).toEqual([{ name: 'DOLLAR', symbol: '$', rate: 1.08 }]);
    expect((await admin.post('/api/currencies/items').send({ manufacturerId: mid.id, item: { name: 'Other', symbol: '$', rate: 1 } })).status).toBe(409);
    expect((await admin.post('/api/currencies/items').send({ manufacturerId: mid.id, item: { name: 'x', symbol: 'y', rate: -1 } })).status).toBe(400);
    const id = a.body.data.id;
    const edit = await admin.patch(`/api/currencies/${id}/items`).send({ match: 'DOLLAR', item: { name: 'USD', symbol: '$', rate: 1.1 } });
    expect(edit.body.data.currency[0]).toMatchObject({ name: 'USD', rate: 1.1 });
  });

  it('deliveries: every partner lands in `delivery` WITH its price (legacy bug wrote `currency` and dropped price)', async () => {
    await admin.post('/api/deliveries/items').send({ manufacturerId: mid.id, item: { name: 'DHL', timeFrame: '2 days', price: '10.5' } });
    const second = await admin.post('/api/deliveries/items').send({ manufacturerId: mid.id, item: { name: 'UPS', timeFrame: '4 days', price: 7, serviceType: 'Express' } });
    expect(second.body.data.delivery).toHaveLength(2);
    expect(second.body.data.delivery[0]).toMatchObject({ name: 'DHL', price: 10.5 });
    expect(second.body.data.delivery[1]).toMatchObject({ name: 'UPS', price: 7, serviceType: 'Express' });
    expect(second.body.data).not.toHaveProperty('currency');
  });

  it('payments: public read, admin write', async () => {
    expect((await request(app).post('/api/payments/items').send({ manufacturerId: mid.id, item: 'Stripe' })).status).toBe(401);
    await admin.post('/api/payments/items').send({ manufacturerId: mid.id, item: 'Stripe' });
    expect((await request(app).get(`/api/payments?manufacturerId=${mid.id}`)).body.data[0].payment).toEqual(['Stripe']);
  });

  it('unknown manufacturer -> 404', async () => {
    expect((await admin.post('/api/countries/items').send({ company: 'Nope', item: 'Italy' })).status).toBe(404);
  });
});

describe('cart', () => {
  let customer;
  beforeEach(async () => {
    await seedCustomer();
    customer = await login('user', { email: 'jane@example.com', password: 'Passw0rdOK' });
  });
  const beans = () => ({ manufacturerId: mid.id, section: 'COFFEE BEANS', productId: mid['COFFEE BEANS'][0].productId });

  it('requires a customer session', async () => {
    expect((await request(app).get('/api/cart')).status).toBe(401);
    expect((await admin.get('/api/cart')).status).toBe(403);
  });

  it('takes price/currency from the catalogue and ignores anything the browser sends', async () => {
    const res = await customer.post('/api/cart/items').send({ ...beans(), quantity: 2, price: 0.01, currency: '$', sum: 0.02 });
    expect(res.status).toBe(201);
    const item = res.body.data.items[0];
    expect(item).toMatchObject({ quantity: 2, currency: '€', sum: '20.00' });
    expect(item.product).toMatchObject({ name: 'Classico', price: 10 });
  });

  it('merges the same product and updates / removes by item id with a server-computed sum', async () => {
    await customer.post('/api/cart/items').send({ ...beans(), quantity: 1 });
    const merged = await customer.post('/api/cart/items').send({ ...beans(), quantity: 2 });
    expect(merged.body.data.items).toHaveLength(1);
    expect(merged.body.data.items[0].quantity).toBe(3);
    const id = merged.body.data.items[0].id;
    const upd = await customer.patch(`/api/cart/items/${id}`).send({ quantity: 5 });
    expect(upd.body.data.items[0]).toMatchObject({ quantity: 5, sum: '50.00' });
    expect((await customer.patch(`/api/cart/items/${id}`).send({ quantity: 0 })).status).toBe(400);
    expect((await customer.patch(`/api/cart/items/${id}`).send({ quantity: 100 })).status).toBe(400);
    const del = await customer.delete(`/api/cart/items/${id}`);
    expect(del.body.data.items).toEqual([]);
  });

  it('only blocks a different currency (legacy check blocked every second item)', async () => {
    await customer.post('/api/cart/items').send({ ...beans(), quantity: 1 });
    const other = await customer.post('/api/cart/items').send({ manufacturerId: mid.id, section: 'ESE PODS', productId: mid['ESE PODS'][0].productId, quantity: 1 });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('CART_CURRENCY_MISMATCH');
    expect(other.body.error.message).toMatch(/£/);
    // same currency, different product is fine
    await admin.patch(`/api/manufacturers/${mid.id}`).send({ products: [{ name: 'Beans2', price: 3, currency: '€' }] });
    const refreshed = (await request(app).get(`/api/manufacturers/${mid.id}`)).body.data;
    const ok = await customer.post('/api/cart/items').send({ manufacturerId: mid.id, section: 'products', productId: refreshed.products[0].productId, quantity: 1 });
    expect(ok.status).toBe(201);
    expect(ok.body.data.items).toHaveLength(2);
  });

  it('refuses hidden/unknown products and hidden sections', async () => {
    const hidden = await customer.post('/api/cart/items').send({ manufacturerId: mid.id, section: 'products', productId: mid.products[0].productId, quantity: 1 });
    expect(hidden.status).toBe(409);
    expect(hidden.body.error.code).toBe('PRODUCT_UNAVAILABLE');
    expect((await customer.post('/api/cart/items').send({ ...beans(), productId: 'nope' })).status).toBe(404);
    await admin.patch(`/api/manufacturers/${mid.id}/visibility`).send({ field: 'coffeeBeansVisibility', value: false });
    expect((await customer.post('/api/cart/items').send(beans())).status).toBe(409);
  });

  it('one customer cannot read or change another customer\'s cart', async () => {
    await customer.post('/api/cart/items').send(beans());
    await seedCustomer({ email: 'other@example.com' });
    const other = await login('user', { email: 'other@example.com', password: 'Passw0rdOK' });
    expect((await other.get('/api/cart')).body.data.items).toEqual([]);
    const itemId = (await customer.get('/api/cart')).body.data.items[0].id;
    expect((await other.delete(`/api/cart/items/${itemId}`)).status).toBe(404);
  });
});

describe('upload targets (Cloudflare R2)', () => {
  it('admin-only; key and content type are chosen by the server; secret never returned', async () => {
    expect((await request(app).post('/api/uploads/signature').send({ purpose: 'logo', mime: 'image/png' })).status).toBe(401);
    const res = await admin.post('/api/uploads/signature').send({ purpose: 'logo', mime: 'image/png', size: 1000, key: 'evil/../escape.png' });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.method).toBe('PUT');
    expect(d.key).toMatch(/^italiancoffee-test\/logos\/[0-9a-f-]{36}\.png$/);
    expect(d.publicUrl).toBe(`https://media.example.test/${d.key}`);
    expect(d.uploadUrl).toMatch(/^https:\/\/acct123\.r2\.cloudflarestorage\.com\/ic-media\/italiancoffee-test\/logos\//);
    expect(d.uploadUrl).toContain('X-Amz-Signature=');
    expect(d.uploadUrl).not.toMatch(/checksum/i); // would invalidate browser uploads
    expect(d.headers['Content-Type']).toBe('image/png');
    expect(JSON.stringify(d)).not.toContain('test-secret-value');
  });

  it('rejects oversized files, unsupported types (incl. SVG) and unknown purposes', async () => {
    expect((await admin.post('/api/uploads/signature').send({ purpose: 'logo', mime: 'image/png', size: 50 * 1024 * 1024 })).status).toBe(400);
    expect((await admin.post('/api/uploads/signature').send({ purpose: 'logo', mime: 'application/pdf' })).status).toBe(400);
    expect((await admin.post('/api/uploads/signature').send({ purpose: 'logo', mime: 'image/svg+xml' })).status).toBe(400);
    expect((await admin.post('/api/uploads/signature').send({ purpose: 'logo' })).status).toBe(400);
    expect((await admin.post('/api/uploads/signature').send({ purpose: 'root-folder', mime: 'image/png' })).status).toBe(400);
  });

  it('reports uploads as disabled when R2 is not configured', async () => {
    const keep = process.env.R2_BUCKET;
    delete process.env.R2_BUCKET;
    resetEnvCache();
    const res = await admin.post('/api/uploads/signature').send({ purpose: 'logo', mime: 'image/png' });
    process.env.R2_BUCKET = keep;
    resetEnvCache();
    expect(res.status).toBe(503);
  });
});

describe('platform behaviour', () => {
  it('health endpoint exposes only a status', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body).toEqual({ status: 'ok' });
  });
  it('unknown routes return a JSON 404; malformed JSON returns 400', async () => {
    expect((await request(app).get('/api/nope')).body.error.code).toBe('NOT_FOUND');
    const bad = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{bad json');
    expect(bad.status).toBe(400);
  });
  it('rejects a browser origin that is not on the allowlist', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    const ok = await request(app).get('/api/health').set('Origin', 'http://localhost:3000');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
  });
  it('sets secure headers and hides the framework', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
  it('never leaks internals on unexpected errors', async () => {
    const original = prisma.tag.findMany;
    prisma.tag.findMany = async () => { throw new Error('mongo://user:secret@host exploded'); };
    const res = await request(app).get('/api/tags');
    prisma.tag.findMany = original;
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/secret|mongo|stack/i);
  });
});
