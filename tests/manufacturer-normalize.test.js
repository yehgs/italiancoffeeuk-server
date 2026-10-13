import { describe, expect, it } from 'vitest';
import {
  coordsFromLegacyPosition,
  manufacturerInputToData,
  manufacturerToLegacy,
  normalizeProduct,
  toBool,
  toDate,
  toNum,
  toStrArray,
} from '../src/utils/manufacturer.js';

describe('coercion helpers', () => {
  it('coerces numbers entered as strings', () => {
    expect(toNum('12.50')).toBe(12.5);
    expect(toNum('1,200')).toBe(1200);
    expect(toNum('', 7)).toBe(7);
    expect(toNum('abc', 0)).toBe(0);
  });
  it('coerces booleans from the shapes Firestore held', () => {
    expect(toBool('true')).toBe(true);
    expect(toBool('No')).toBe(false);
    expect(toBool('', true)).toBe(true);
    expect(toBool(undefined, false)).toBe(false);
  });
  it('turns "" / scalars / objects into string arrays', () => {
    expect(toStrArray('')).toEqual([]);
    expect(toStrArray('a')).toEqual(['a']);
    expect(toStrArray([{ name: 'x' }, 'y', null])).toEqual(['x', 'y']);
  });
  it('converts Firestore timestamps and ISO dates', () => {
    expect(toDate({ seconds: 1700000000, nanoseconds: 500_000_000 }).toISOString()).toBe('2023-11-14T22:13:20.500Z');
    expect(toDate({ _seconds: 1700000000, _nanoseconds: 0 }).toISOString()).toBe('2023-11-14T22:13:20.000Z');
    expect(toDate('2024-01-02T03:04:05Z').toISOString()).toBe('2024-01-02T03:04:05.000Z');
    expect(toDate('nope')).toBeUndefined();
  });
});

describe('normalizeProduct', () => {
  it('assigns a stable id, numeric price and defaults', () => {
    const p = normalizeProduct({ name: 'Espresso', price: '9.90', images: [''], visibility: '' });
    expect(p.productId).toMatch(/[0-9a-f-]{36}/);
    expect(p.price).toBe(9.9);
    expect(p.currency).toBe('€');
    expect(p.visibility).toBe(true);
  });
  it('keeps an existing productId', () => {
    expect(normalizeProduct({ productId: 'abc', name: 'x' }).productId).toBe('abc');
  });
});

describe('coordsFromLegacyPosition', () => {
  it('treats position[0] as latitude (what the old map rendered)', () => {
    expect(coordsFromLegacyPosition([41.9, 12.49])).toMatchObject({ latitude: 41.9, longitude: 12.49 });
  });
  it('swaps a pair that was entered longitude-first', () => {
    const r = coordsFromLegacyPosition([120.5, 40.1]);
    expect(r).toMatchObject({ latitude: 40.1, longitude: 120.5 });
    expect(r.warnings.join()).toMatch(/swapped/);
  });
  it('ignores impossible coordinates', () => {
    expect(coordsFromLegacyPosition([200, 300]).latitude).toBeUndefined();
  });
});

describe('manufacturerInputToData', () => {
  it('maps legacy field names and only emits keys that were sent', () => {
    const { data } = manufacturerInputToData({ company: ' Illy ', youtube_link: 'y', sales_online: 'true', company_rate: '9' });
    expect(data).toEqual({ company: ' Illy ', companyKey: 'illy', youtubeLink: 'y', salesOnline: true, companyRate: 5 });
  });
  it('normalizes the five product lists, including legacy "COFFEE BEANS"', () => {
    const { data } = manufacturerInputToData({ 'COFFEE BEANS': [{ name: 'a', price: '3' }], products: [] });
    expect(data.coffeeBeans[0]).toMatchObject({ name: 'a', price: 3 });
    expect(data.products).toEqual([]);
  });
  it('accepts the legacy {facebook: ""} socials object and drops blanks', () => {
    expect(manufacturerInputToData({ socials: { facebook: '' } }).data.socials).toEqual([]);
    expect(manufacturerInputToData({ socials: { facebook: 'fb' } }).data.socials).toEqual([{ type: 'facebook', link: 'fb' }]);
  });
  it('prefers explicit latitude/longitude over legacy position and validates ranges', () => {
    const ok = manufacturerInputToData({ latitude: '41.9', longitude: '12.5', position: [1, 2] }).data;
    expect(ok).toMatchObject({ latitude: 41.9, longitude: 12.5 });
    const bad = manufacturerInputToData({ latitude: 123 });
    expect(bad.data.latitude).toBeUndefined();
    expect(bad.warnings).toContain('latitude out of range');
  });
  it('drops UI-state keys the old edit form wrote into Firestore, and reports them', () => {
    const { data, warnings } = manufacturerInputToData({ company: 'A', terms: 'x', privacy: 'y', rate: 3, id: 'ignored' });
    expect(data.terms).toBeUndefined();
    expect(warnings).toEqual(expect.arrayContaining(['unknown field dropped: terms', 'unknown field dropped: privacy', 'unknown field dropped: rate']));
    expect(warnings.join()).not.toMatch(/: id/);
  });
});

describe('manufacturerToLegacy', () => {
  const base = {
    id: 'm1', company: 'Illy', latitude: 41.9, longitude: 12.5, companyRate: 4, reviewCount: 3, ratingCount: 2, ratingSum: 9,
    coffeeBeans: [{ productId: 'p', name: 'Bean', price: 5, currency: '€', images: [], videos: [] }],
    createdAt: new Date('2024-01-01T00:00:00Z'), updatedAt: new Date('2024-01-02T00:00:00Z'),
  };
  it('keeps legacy keys, position as [lat,lng] and uses real review stats', () => {
    const out = manufacturerToLegacy(base);
    expect(out.position).toEqual([41.9, 12.5]);
    expect(out['COFFEE BEANS'][0].name).toBe('Bean');
    expect(out.reviewCount).toBe(3);
    expect(out.averageRating).toBe(4.5); // 9 / 2 rated reviews, unrated ones excluded
    expect(out.createdAt).toBe('2024-01-01T00:00:00.000Z');
  });
  it('never exposes counters named ratingSum', () => {
    expect(manufacturerToLegacy(base)).not.toHaveProperty('ratingSum');
  });
});

describe('script-scheme URLs are dropped from media fields', () => {
  it('logo, gallery and product media', () => {
    const { data } = manufacturerInputToData({
      logo: 'javascript:alert(1)', logo_small: 'https://res.cloudinary.com/a.png',
      gallery: ['https://ok/1.png', ' JavaScript:alert(2)', 'data:text/html;base64,AAA'],
      products: [{ name: 'p', image: 'vbscript:x', images: ['javascript:y', 'https://ok/2.png'] }],
    });
    expect(data.logo).toBeNull();
    expect(data.logoSmall).toBe('https://res.cloudinary.com/a.png');
    expect(data.gallery).toEqual(['https://ok/1.png']);
    expect(data.products[0].image).toBeUndefined();
    expect(data.products[0].images).toEqual(['https://ok/2.png']);
  });
});
