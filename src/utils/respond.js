export const ok = (res, data, meta, status = 200) => res.status(status).json(meta ? { data, meta } : { data });
export const created = (res, data, meta) => ok(res, data, meta, 201);
export const paged = (items, total, { page, limit }) => ({ data: items, meta: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) } });
