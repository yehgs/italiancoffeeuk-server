import { Router } from 'express';
import { z } from 'zod';
import { requireCustomer } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import * as svc from '../services/cartService.js';
import { cartAddBody, cartUpdateBody } from '../validators/schemas.js';
import { created, ok } from '../utils/respond.js';

const router = Router();
router.use(requireCustomer);
const itemParams = z.object({ itemId: z.string().min(1).max(100) });

router.get('/', async (req, res) => ok(res, await svc.getCart(req.auth.id)));
router.post('/items', validate({ body: cartAddBody }), async (req, res) => created(res, await svc.addToCart(req.auth.id, req.valid.body)));
router.patch('/items/:itemId', validate({ params: itemParams, body: cartUpdateBody }), async (req, res) =>
  ok(res, await svc.updateQuantity(req.auth.id, req.valid.params.itemId, req.valid.body.quantity)),
);
router.delete('/items/:itemId', validate({ params: itemParams }), async (req, res) =>
  ok(res, await svc.removeItem(req.auth.id, req.valid.params.itemId)),
);
router.delete('/', async (req, res) => ok(res, await svc.clearCart(req.auth.id)));
export default router;
