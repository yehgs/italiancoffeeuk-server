import { describe, expect, it } from 'vitest';
import { app, prisma, request } from './helpers/app.js';

describe('public newsletter unsubscribe', () => {
  it('removes a subscribed address (case-insensitive)', async () => {
    await request(app).post('/api/subscribers').send({ email: 'Bean@Example.com' }).expect(201);
    const res = await request(app).post('/api/subscribers/unsubscribe').send({ email: 'bean@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true });
    expect(await prisma.subscriber.count()).toBe(0);
  });

  it('answers identically for an address that was never subscribed', async () => {
    const res = await request(app).post('/api/subscribers/unsubscribe').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true });
  });

  it('rejects an invalid email', async () => {
    const res = await request(app).post('/api/subscribers/unsubscribe').send({ email: 'nope' });
    expect(res.status).toBe(400);
  });

  it('only removes the requested address', async () => {
    await request(app).post('/api/subscribers').send({ email: 'a@example.com' });
    await request(app).post('/api/subscribers').send({ email: 'b@example.com' });
    await request(app).post('/api/subscribers/unsubscribe').send({ email: 'a@example.com' });
    const left = await prisma.subscriber.findMany({});
    expect(left.map((s) => s.email)).toEqual(['b@example.com']);
  });
});
