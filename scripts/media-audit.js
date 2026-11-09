#!/usr/bin/env node
/**
 * Checks every image URL in the database and says exactly why the broken ones fail.
 *
 *   npm run media:audit                 # report only (changes nothing)
 *   npm run media:audit -- --apply      # copy working Cloudinary images to R2 and rewrite the database
 *
 * Run it on a computer that can reach Cloudinary (your own PC). Needs DATABASE_URL in server/.env;
 * --apply also needs the R2_* values.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PutObjectCommand } from '@aws-sdk/client-s3';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const { env } = await import('../src/config/env.js');
const { prisma } = await import('../src/config/prisma.js');
const { getS3, storageConfigured } = await import('../src/config/storage.js');
const { auditMedia } = await import('../src/migration/media.js');

const apply = Boolean(args.apply);
const legacyHosts = String(args.host || 'res.cloudinary.com').split(',');
let storage;
if (storageConfigured()) {
  storage = {
    publicBase: env.R2_PUBLIC_BASE_URL,
    keyPrefix: env.R2_KEY_PREFIX,
    put: (key, body, contentType) => getS3().send(new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, Body: body, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable' })),
  };
} else if (apply) {
  console.error('--apply needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET and R2_PUBLIC_BASE_URL in server/.env');
  process.exit(2);
}

try {
  console.log(apply ? 'Checking every image and copying working ones to R2…' : 'Checking every image (read-only)…');
  const { summary, rows } = await auditMedia({
    prisma, apply, legacyHosts, storage,
    log: (n, total, r) => process.stdout.write(`\r  ${n}/${total} ${r.ok ? 'ok ' : 'BAD'}`),
  });
  console.log('\n');
  const broken = rows.filter((r) => !r.ok);
  const reasons = new Map();
  for (const r of broken) { const k = `${r.host} — ${r.why.text}`; reasons.set(k, (reasons.get(k) || 0) + 1); }
  console.log(`References: ${summary.references}   distinct URLs: ${summary.distinctUrls}   working: ${summary.working}   broken: ${summary.broken}`);
  for (const [k, n] of reasons) console.log(`  ✗ ${n} × ${k}`);
  if (broken[0]) console.log(`\n  Example broken URL:\n  ${broken[0].url}\n  (open it in your browser to see Cloudinary's own message)`);
  if (apply) console.log(`\nCopied to R2: ${summary.copiedToR2}   documents updated: ${summary.documentsUpdated}`);
  fs.mkdirSync('reports', { recursive: true });
  const file = path.join('reports', `media-${new Date().toISOString().replace(/[:.]/g, '-')}${apply ? '' : '-dry'}.json`);
  fs.writeFileSync(file, JSON.stringify({ summary, rows }, null, 2));
  console.log(`\nFull list (every image, where it is used, why it fails): ${file}`);
  if (broken.length) console.log('Broken images cannot be repaired by this tool: re-upload them in Admin > Manufacturers > Edit (they are stored in R2).');
  process.exitCode = broken.length ? 1 : 0;
} finally {
  await prisma.$disconnect();
}
