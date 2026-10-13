import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import * as svc from '../services/settingsService.js';
import { idParams, objectId, settingsItemSchemas } from '../validators/schemas.js';
import { created, ok } from '../utils/respond.js';

const targetQuery = z.object({ manufacturerId: objectId.optional(), company: z.string().trim().max(200).optional() });

/**
 * /api/countries | /api/currencies | /api/payments | /api/deliveries
 *   GET    /?company=|manufacturerId=      -> [{ id, company, <list> }]   (public: needed by the cart)
 *   POST   /items       { manufacturerId|company, item }                  (admin)
 *   PATCH  /:id/items   { match, item }                                   (admin)
 *   DELETE /:id/items?match=                                              (admin)
 */
export function settingsRouter(type) {
  const router = Router();
  const item = settingsItemSchemas[type];

  router.get('/', validate({ query: targetQuery }), async (req, res) => ok(res, await svc.listSettings(type, req.valid.query)));

  router.post(
    '/items',
    requireAdmin,
    validate({ body: targetQuery.extend({ item }).refine((v) => v.manufacturerId || v.company, 'manufacturerId or company is required') }),
    async (req, res) => {
      const { item: value, ...target } = req.valid.body;
      created(res, await svc.addItem(type, target, value));
    },
  );

  router.patch(
    '/:id/items',
    requireAdmin,
    validate({ params: idParams, body: z.object({ match: z.string().min(1).max(200), item }) }),
    async (req, res) => ok(res, await svc.updateItem(type, req.valid.params.id, req.valid.body.match, req.valid.body.item)),
  );

  router.delete(
    '/:id/items',
    requireAdmin,
    validate({ params: idParams, query: z.object({ match: z.string().min(1).max(200) }) }),
    async (req, res) => ok(res, await svc.removeItem(type, req.valid.params.id, req.valid.query.match)),
  );
  return router;
}
