import { Router } from 'express';
import { requireAdmin } from '../middleware/authenticate.js';
import { subscribeLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import * as svc from '../services/subscriberService.js';
import { idParams, pageQuery, subscriberBody } from '../validators/schemas.js';
import { created, paged } from '../utils/respond.js';

const router = Router();
router.post('/', subscribeLimiter, validate({ body: subscriberBody }), async (req, res) =>
  created(res, await svc.subscribe(req.valid.body.email)),
);
router.get('/', requireAdmin, validate({ query: pageQuery }), async (req, res) => {
  const { items, total } = await svc.listSubscribers(req.valid.query);
  res.json(paged(items, total, req.valid.query));
});
router.delete('/:id', requireAdmin, validate({ params: idParams }), async (req, res) => {
  await svc.deleteSubscriber(req.valid.params.id);
  res.status(204).end();
});
export default router;
