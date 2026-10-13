import { PrismaClient } from '@prisma/client';
import { env } from './env.js';

// Single shared client. Tests replace this module with an in-memory fake.
export const prisma = new PrismaClient({
  datasources: { db: { url: env.DATABASE_URL } },
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});
