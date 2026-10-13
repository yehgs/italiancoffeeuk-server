import { describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/config/prisma.js';
import { runImport } from '../src/migration/importer.js';
import { verifyImport } from '../src/migration/verify.js';
import { exportData } from './fixtures/firestore-export.js';

const run = (extra = {}) => runImport({ prisma, data: exportData(), bcryptRounds: 4, ...extra });

describe('Firestore import', () => {
  it('imports every collection and reports exact counts', async () => {
    const r = await run();
    expect(r.stats.tags).toMatchObject({ read: 3, created: 2, skipped: 1, failed: 0 }); // ' espresso ' is a duplicate
    expect(r.stats.manufacturerType).toMatchObject({ read: 2, created: 2 });
    expect(r.stats.manufacturer).toMatchObject({ read: 4, created: 2, failed: 2 });
    expect(r.stats.subscribers).toMatchObject({ read: 3, created: 2, skipped: 1 });
    expect(await prisma.manufacturer.count({})).toBe(2);
  });

  it('reports failures with reasons (duplicate company, missing name, unknown company)', async () => {
    const r = await run();
    const reasons = r.failures.map((f) => `${f.collection}:${f.id}:${f.reason}`).join('\n');
    expect(reasons).toMatch(/manufacturer:m3:duplicate company name/);
    expect(reasons).toMatch(/manufacturer:m4:missing company name/);
    expect(reasons).toMatch(/currency:cu2:no manufacturer named "Nobody"/);
    expect(reasons).toMatch(/reviews:m1:review without comment/);
  });

  it('transforms manufacturers: coercions, timestamps, coordinates, stable product ids', async () => {
    await run();
    const m = (await prisma.manufacturer.findFirst({ where: { companyKey: 'illy caffè' } }));
    expect(m.createdAt.toISOString()).toBe('2023-11-14T22:13:20.000Z');
    expect(m.companyRate).toBe(4);
    expect(m.salesOnline).toBe(true);
    expect(m.academy).toBe(false); // "" -> default
    expect(m.merchandise).toEqual([]);
    expect(m.socials).toEqual([]);
    expect(m.latitude).toBe(45.65);
    expect(m.coffeeBeans[0]).toMatchObject({ name: 'Classico', price: 12.5 });
    expect(m.coffeeBeans[0].productId).toBeTruthy();
    expect(m.legacyFirebaseId).toBe('m1');
    const lav = await prisma.manufacturer.findFirst({ where: { companyKey: 'lavazza' } });
    expect([lav.latitude, lav.longitude]).toEqual([40.1, 120.5]); // longitude-first pair was swapped
  });

  it('extracts reviews into their own collection and recomputes counters', async () => {
    const r = await run();
    const m = await prisma.manufacturer.findFirst({ where: { companyKey: 'illy caffè' } });
    expect(await prisma.review.count({ where: { manufacturerId: m.id } })).toBe(2);
    expect([m.reviewCount, m.ratingCount, m.ratingSum]).toEqual([2, 1, 5]);
    expect(r.stats.reviews.created).toBe(2);
  });

  it('settings follow the company, merge/dedupe, and recover the delivery-bug data', async () => {
    const r = await run();
    const m = await prisma.manufacturer.findFirst({ where: { companyKey: 'illy caffè' } });
    expect((await prisma.countrySetting.findUnique({ where: { manufacturerId: m.id } })).country).toEqual(['Italy', 'France']);
    expect((await prisma.paymentSetting.findUnique({ where: { manufacturerId: m.id } })).payment).toEqual(['Stripe', 'PayPal']);
    expect((await prisma.currencySetting.findUnique({ where: { manufacturerId: m.id } })).currency).toEqual([{ name: 'DOLLAR', symbol: '$', rate: 1.08 }]);
    const delivery = (await prisma.deliverySetting.findUnique({ where: { manufacturerId: m.id } })).delivery;
    expect(delivery.map((d) => d.name)).toEqual(['DHL', 'UPS']);
    expect(delivery[1]).toMatchObject({ price: 0, serviceType: 'Express' });
    expect(r.warnings.some((w) => /recovered from the misnamed "currency"/.test(w.message))).toBe(true);
  });

  it('hashes admin passwords, forces a change, and leaks no plaintext anywhere', async () => {
    const r = await run();
    const ada = await prisma.admin.findUnique({ where: { email: 'ada@example.com' } });
    expect(ada.role).toBe('superadmin');
    expect(ada.mustChangePassword).toBe(true);
    expect(await bcrypt.compare('plaintext-secret-1', ada.passwordHash)).toBe(true);
    const everything = JSON.stringify([r, prisma.migrationLedger.__rows(), prisma.admin.__rows().map((a) => ({ ...a, passwordHash: undefined }))]);
    expect(everything).not.toMatch(/plaintext-secret/);
  });

  it('users: merges Firestore profile + Auth export, no password hash, dedupes by email', async () => {
    const r = await run();
    const jane = await prisma.user.findUnique({ where: { email: 'jane@example.com' } });
    expect(jane).toMatchObject({ firstName: 'Jane', lastName: 'Doe', passwordHash: null, deliveryAddress: true, legacyFirebaseUid: 'fbU1' });
    const authOnly = await prisma.user.findUnique({ where: { email: 'authonly@example.com' } });
    expect(authOnly).toMatchObject({ firstName: 'Auth', lastName: 'Only Person', passwordHash: null });
    expect(await prisma.user.count({})).toBe(2);
    expect(r.warnings.some((w) => /duplicate profile/.test(w.message))).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/jane@example|authonly@example/);
  });

  it('does not migrate carts, and says why', async () => {
    const r = await run();
    expect(r.warnings.some((w) => w.collection === 'carts' && /NOT migrated/.test(w.message))).toBe(true);
    expect(prisma.cart.__rows()).toHaveLength(0);
  });

  it('is idempotent: a second run changes nothing', async () => {
    await run();
    const snapshot = JSON.stringify([
      prisma.manufacturer.__rows().length, prisma.review.__rows().length, prisma.user.__rows().length,
      prisma.admin.__rows().length, prisma.subscriber.__rows().length, prisma.migrationLedger.__rows().length,
    ]);
    const second = await run();
    for (const [name, s] of Object.entries(second.stats)) {
      expect(s.created, `${name} created on rerun`).toBe(0);
      expect(s.updated, `${name} updated on rerun`).toBe(0);
    }
    expect(JSON.stringify([
      prisma.manufacturer.__rows().length, prisma.review.__rows().length, prisma.user.__rows().length,
      prisma.admin.__rows().length, prisma.subscriber.__rows().length, prisma.migrationLedger.__rows().length,
    ])).toBe(snapshot);
  });

  it('a changed source document is updated on rerun, and an admin password is never overwritten', async () => {
    await run();
    const data = exportData();
    data.collections.manufacturer[0].history = 'Founded 1933';
    data.collections.admins[0].password = 'changed-in-source';
    const second = await runImport({ prisma, data, bcryptRounds: 4 });
    expect(second.stats.manufacturer.updated).toBe(1);
    const m = await prisma.manufacturer.findFirst({ where: { companyKey: 'illy caffè' } });
    expect(m.history).toBe('Founded 1933');
    const ada = await prisma.admin.findUnique({ where: { email: 'ada@example.com' } });
    expect(await bcrypt.compare('plaintext-secret-1', ada.passwordHash)).toBe(true);
  });

  it('dry run reads and transforms everything but writes nothing', async () => {
    const r = await run({ dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.stats.manufacturer.created).toBe(2);
    for (const model of ['manufacturer', 'review', 'user', 'admin', 'tag', 'subscriber', 'migrationLedger']) {
      expect(prisma[model].__rows(), model).toHaveLength(0);
    }
  });

  it('--only restricts the collections, and dependent phases still resolve existing data', async () => {
    await run({ only: ['manufacturer'] });
    expect(await prisma.tag.count({})).toBe(0);
    const r = await run({ only: ['countries'] });
    expect(r.stats.countries).toMatchObject({ created: 1, failed: 0 });
  });

  it('links to (rather than duplicates) records the live app already created', async () => {
    await prisma.subscriber.create({ data: { email: 'fan@example.com' } });
    const r = await run();
    expect(await prisma.subscriber.count({ where: { email: 'fan@example.com' } })).toBe(1);
    expect(r.warnings.some((w) => /linked instead of creating/.test(w.message))).toBe(true);
  });
});

describe('verify-import', () => {
  it('passes after a clean import and flags a tampered database', async () => {
    const data = exportData();
    await runImport({ prisma, data, bcryptRounds: 4 });
    const ok = await verifyImport({ prisma, data });
    expect(ok.findings.filter((f) => f.level === 'error')).toEqual([]);
    expect(ok.ok).toBe(true);

    const m = await prisma.manufacturer.findFirst({ where: { companyKey: 'illy caffè' } });
    await prisma.manufacturer.update({ where: { id: m.id }, data: { coffeeBeans: { set: [] } } });
    const bad = await verifyImport({ prisma, data });
    expect(bad.ok).toBe(false);
    expect(bad.findings.some((f) => f.check === 'products' && /COFFEE BEANS has 1 in source but 0/.test(f.message))).toBe(true);
  });

  it('checks media URLs when asked', async () => {
    const data = exportData();
    await runImport({ prisma, data, bcryptRounds: 4 });
    const res = await verifyImport({ prisma, data, checkUrls: true, fetchImpl: async (u) => ({ ok: !u.includes('illy.png'), status: 404 }) });
    expect(res.findings.some((f) => f.check === 'url' && /404 .*illy\.png/.test(f.message))).toBe(true);
  });
});
