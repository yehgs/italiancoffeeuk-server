import { Router } from 'express';
import { prisma } from '../config/prisma.js';

const router = Router();

// Exposes only up/down; no versions, hostnames or connection details.
router.get('/', async (_req, res) => {
  try {
    await prisma.$runCommandRaw({ ping: 1 });
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'degraded' });
  }
});
export default router;
