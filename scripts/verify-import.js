#!/usr/bin/env node
/** node --env-file=.env scripts/verify-import.js --dir=./export [--check-urls] */
import path from 'node:path';
import { loadExport } from '../src/migration/loader.js';
import { verifyImport } from '../src/migration/verify.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
if (!args.dir) { console.error('Missing --dir=<export directory>'); process.exit(2); }

const { prisma } = await import('../src/config/prisma.js');
try {
  const result = await verifyImport({ prisma, data: loadExport(path.resolve(args.dir)), checkUrls: Boolean(args['check-urls']) });
  for (const f of result.findings) console.log(`${f.level.toUpperCase().padEnd(5)} [${f.check}] ${f.message}`);
  console.log(result.ok ? '\nVERIFY PASSED' : '\nVERIFY FAILED');
  process.exitCode = result.ok ? 0 : 1;
} finally {
  await prisma.$disconnect();
}
