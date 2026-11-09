import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { prisma } from './config/prisma.js';
import { logMailStatus } from './config/mailHealth.js';
import { purgeExpired } from './services/authService.js';
import { bootstrapAdmin } from './services/adminService.js';

const app = createApp();

await prisma.$connect();
await bootstrapAdmin({ email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD, logger });
for (const w of env.warnings ?? []) logger.warn(w);
const sweep = () => purgeExpired().then((r) => (r.sessions || r.resets) && logger.info(r, 'purged expired sessions/reset tokens')).catch((e) => logger.error({ err: e.message }, 'purge failed'));
sweep();
setInterval(sweep, 6 * 3600_000).unref();
logMailStatus(); // loud, specific log lines if email cannot work (does not block startup)

const server = app.listen(env.PORT, () => logger.info(`API listening on :${env.PORT} (${env.NODE_ENV})`));

// Graceful shutdown: stop accepting connections, finish in-flight requests, disconnect Prisma.
let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
