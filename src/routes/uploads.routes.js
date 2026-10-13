import { Router } from 'express';
import { requireAdmin } from '../middleware/authenticate.js';
import { uploadSignLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { createUploadTarget } from '../services/uploadService.js';
import { uploadSignBody } from '../validators/schemas.js';
import { ok } from '../utils/respond.js';

const router = Router();
router.post('/signature', requireAdmin, uploadSignLimiter, validate({ body: uploadSignBody }), async (req, res) =>
  ok(res, await createUploadTarget(req.valid.body)),
);
export default router;
