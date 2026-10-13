// Runs before every test file: deterministic env, no real DB, no network.
process.env.R2_ACCOUNT_ID = 'acct123';
process.env.R2_ACCESS_KEY_ID = 'AKIATESTKEY';
process.env.R2_SECRET_ACCESS_KEY = 'test-secret-value';
process.env.R2_BUCKET = 'ic-media';
process.env.R2_PUBLIC_BASE_URL = 'https://media.example.test/';
process.env.R2_KEY_PREFIX = 'italiancoffee-test';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'mongodb://localhost:27017/test?replicaSet=rs0';
process.env.CORS_ORIGINS = 'http://localhost:3000';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.LOG_LEVEL = 'silent';
process.env.BCRYPT_ROUNDS = '10';
process.env.MAIL_TRANSPORT = 'none';

import { vi, beforeEach } from 'vitest';

// Every test file talks to the same in-memory fake instead of MongoDB.
vi.mock('../../src/config/prisma.js', async () => {
  const { createFakePrisma } = await import('./fakePrisma.js');
  return { prisma: createFakePrisma() };
});

beforeEach(async () => {
  const { prisma } = await import('../../src/config/prisma.js');
  prisma.__reset();
});
