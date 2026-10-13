import crypto from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';
import { getS3, storageConfigured } from '../config/storage.js';
import { HttpError, badRequest } from '../utils/httpError.js';

// The extension is derived from the MIME type here, never taken from the client's file name.
// SVG is deliberately excluded: an SVG served from the media domain can carry scripts.
const TYPES = {
  image: {
    maxBytes: 10 * 1024 * 1024,
    mimes: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' },
  },
  video: {
    maxBytes: 100 * 1024 * 1024,
    mimes: { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' },
  },
};
const FOLDERS = {
  logo: 'logos',
  gallery: 'gallery',
  product: 'products',
  'manufacturer-type': 'manufacturer-types',
  misc: 'misc',
};
const EXPIRES_SECONDS = 300;

/**
 * Returns a short-lived presigned PUT URL for a *direct* browser -> Cloudflare R2 upload.
 * The key (folder + random name + extension) and content type are fixed here, so the
 * client cannot write anywhere else or choose another file type. The R2 secret never
 * leaves the server.
 */
export async function createUploadTarget({ purpose, resourceType, mime, size }) {
  if (!storageConfigured()) throw new HttpError(503, 'UPLOADS_DISABLED', 'File uploads are not configured');
  const limit = TYPES[resourceType];
  if (!mime) throw badRequest('File type is required');
  const ext = limit.mimes[mime];
  if (!ext) throw badRequest(`Unsupported ${resourceType} type (${Object.keys(limit.mimes).join(', ')})`);
  if (size && size > limit.maxBytes) throw badRequest(`File is too large (max ${Math.round(limit.maxBytes / 1048576)}MB)`);

  const key = `${env.R2_KEY_PREFIX}/${FOLDERS[purpose]}/${crypto.randomUUID()}.${ext}`;
  const uploadUrl = await getSignedUrl(
    getS3(),
    new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, ContentType: mime, CacheControl: 'public, max-age=31536000, immutable' }),
    { expiresIn: EXPIRES_SECONDS, signableHeaders: new Set(['content-type', 'cache-control']) },
  );
  return {
    method: 'PUT',
    uploadUrl,
    // The browser must send exactly these headers or R2 rejects the signature.
    headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' },
    key,
    publicUrl: `${env.R2_PUBLIC_BASE_URL.replace(/\/+$/, '')}/${key}`,
    maxBytes: limit.maxBytes,
    expiresIn: EXPIRES_SECONDS,
  };
}
