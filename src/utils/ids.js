import { badRequest } from './httpError.js';

const OBJECT_ID = /^[a-f0-9]{24}$/i;
export const isObjectId = (v) => typeof v === 'string' && OBJECT_ID.test(v);
export function assertObjectId(v, label = 'id') {
  if (!isObjectId(v)) throw badRequest(`Invalid ${label}`);
  return v;
}

export const normalizeEmail = (e) => String(e ?? '').trim().toLowerCase();
export const normalizeKey = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
