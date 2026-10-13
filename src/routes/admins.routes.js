import { Router } from 'express';
import { requireSuperAdmin } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import * as svc from '../services/adminService.js';
import { adminCreateBody, adminUpdateBody, idParams } from '../validators/schemas.js';
import { created, ok } from '../utils/respond.js';

const router = Router();
router.use(requireSuperAdmin);

router.get('/', async (_req, res) => ok(res, await svc.listAdmins()));
router.post('/', validate({ body: adminCreateBody }), async (req, res) => created(res, await svc.createAdmin(req.valid.body)));
router.patch('/:id', validate({ params: idParams, body: adminUpdateBody }), async (req, res) =>
  ok(res, await svc.updateAdmin(req.valid.params.id, req.valid.body, req.auth.subject)),
);
router.delete('/:id', validate({ params: idParams }), async (req, res) => {
  await svc.deleteAdmin(req.valid.params.id, req.auth.subject);
  res.status(204).end();
});
export default router;
