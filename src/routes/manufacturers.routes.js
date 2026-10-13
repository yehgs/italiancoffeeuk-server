import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireCustomer } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import * as svc from '../services/manufacturerService.js';
import * as reviews from '../services/reviewService.js';
import * as schemas from '../validators/schemas.js';
import { created, ok, paged } from '../utils/respond.js';

const router = Router();

const listQuery = schemas.pageQuery.extend({
  q: z.string().trim().max(100).optional(),
  province: z.string().trim().max(100).optional(),
});

router.get('/', validate({ query: listQuery }), async (req, res) => {
  const { items, total } = await svc.listManufacturers(req.valid.query);
  res.json(paged(items, total, req.valid.query));
});

router.get('/:id', validate({ params: schemas.idParams }), async (req, res) => {
  ok(res, await svc.getManufacturer(req.valid.params.id));
});

router.post('/', requireAdmin, async (req, res) => {
  const { manufacturer, warnings } = await svc.createManufacturer(req.body, req.auth.subject);
  created(res, manufacturer, warnings.length ? { warnings } : undefined);
});

router.patch('/:id', requireAdmin, validate({ params: schemas.idParams }), async (req, res) => {
  const { manufacturer, warnings } = await svc.updateManufacturer(req.valid.params.id, req.body);
  ok(res, manufacturer, warnings.length ? { warnings } : undefined);
});

router.delete('/:id', requireAdmin, validate({ params: schemas.idParams }), async (req, res) => {
  await svc.deleteManufacturer(req.valid.params.id);
  res.status(204).end();
});

router.patch(
  '/:id/visibility',
  requireAdmin,
  validate({
    params: schemas.idParams,
    body: z.object({ field: z.string().max(60), value: z.boolean() }),
  }),
  async (req, res) => {
    ok(res, await svc.setManufacturerVisibility(req.valid.params.id, req.valid.body.field, req.valid.body.value));
  },
);

router.patch(
  '/:id/products/:productId/visibility',
  requireAdmin,
  validate({
    params: schemas.idParams.extend({ productId: z.string().min(1).max(100) }),
    body: z.object({
      section: z.enum(['products', 'COFFEE BEANS', 'COMPATIBLE CAPSULES', 'ESE PODS', 'GRINDED COFFEE']),
      visible: z.boolean(),
    }),
  }),
  async (req, res) => {
    const { id, productId } = req.valid.params;
    ok(res, await svc.setProductVisibility(id, req.valid.body.section, productId, req.valid.body.visible));
  },
);

// ── reviews ──
router.get(
  '/:id/reviews',
  validate({ params: schemas.idParams, query: schemas.pageQuery.extend({ limit: z.coerce.number().int().min(1).max(50).default(20) }) }),
  async (req, res) => {
    const { items, total } = await reviews.listReviews(req.valid.params.id, req.valid.query);
    res.json(paged(items, total, req.valid.query));
  },
);

router.post(
  '/:id/reviews',
  requireCustomer,
  validate({ params: schemas.idParams, body: schemas.reviewBody }),
  async (req, res) => {
    created(res, await reviews.addReview(req.valid.params.id, req.auth.subject, req.valid.body));
  },
);

export default router;
