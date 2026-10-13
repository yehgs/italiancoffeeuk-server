import { Router } from 'express';
import { requireAdmin } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import * as svc from '../services/filterService.js';
import { filterBodies, idParams } from '../validators/schemas.js';
import { created, ok } from '../utils/respond.js';

/** Mounts list/create/update/delete for one filter list, e.g. /api/tags. */
export function filterRouter(name) {
  const router = Router();
  const body = filterBodies[name];
  router.get('/', async (_req, res) => ok(res, await svc.listFilter(name)));
  router.post('/', requireAdmin, validate({ body }), async (req, res) => created(res, await svc.createFilter(name, req.valid.body)));
  router.patch('/:id', requireAdmin, validate({ params: idParams, body: body.partial() }), async (req, res) =>
    ok(res, await svc.updateFilter(name, req.valid.params.id, req.valid.body)),
  );
  router.delete('/:id', requireAdmin, validate({ params: idParams }), async (req, res) => {
    await svc.deleteFilter(name, req.valid.params.id);
    res.status(204).end();
  });
  return router;
}
