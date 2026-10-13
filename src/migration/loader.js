import fs from 'node:fs';
import path from 'node:path';
import { COLLECTION_ORDER } from './importer.js';

const EXTRA = ['carts'];

/** Reads <dir>/<collection>.json (array of docs) and <dir>/auth-users.json. Missing files are fine. */
export function loadExport(dir) {
  const collections = {};
  for (const name of [...COLLECTION_ORDER, ...EXTRA]) {
    const file = path.join(dir, `${name}.json`);
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array`);
    collections[name] = parsed;
  }
  const authFile = path.join(dir, 'auth-users.json');
  const authUsers = fs.existsSync(authFile) ? JSON.parse(fs.readFileSync(authFile, 'utf8')) : [];
  return { collections, authUsers };
}
