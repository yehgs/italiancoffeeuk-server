/**
 * validate({ body, query, params }) — parsed values land on req.valid.*
 * (Express 5 makes req.query read-only, so we never reassign it.)
 */
export const validate = (schemas) => (req, _res, next) => {
  req.valid = req.valid ?? {};
  if (schemas.body) req.valid.body = schemas.body.parse(req.body ?? {});
  if (schemas.query) req.valid.query = schemas.query.parse(req.query ?? {});
  if (schemas.params) req.valid.params = schemas.params.parse(req.params ?? {});
  next();
};
