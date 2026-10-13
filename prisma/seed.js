// Idempotent bootstrap: creates the first super-admin from env if none exists.
// No catalogue data is fabricated; real data comes from `npm run migrate:import`.
import { env } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { prisma } from '../src/config/prisma.js';
import { bootstrapAdmin } from '../src/services/adminService.js';

try {
  if (!env.BOOTSTRAP_ADMIN_EMAIL || !env.BOOTSTRAP_ADMIN_PASSWORD) {
    logger.warn('BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD not set; nothing to seed');
  } else {
    await bootstrapAdmin({ email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD, logger });
    logger.info('seed complete');
  }
} finally {
  await prisma.$disconnect();
}
