import { S3Client } from '@aws-sdk/client-s3';
import { env } from './env.js';

/** Cloudflare R2 speaks the S3 API. All five values are required for uploads. */
export function storageConfigured() {
  return Boolean(
    env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET && env.R2_PUBLIC_BASE_URL,
  );
}

let client;
export function getS3() {
  client ??= new S3Client({
    region: 'auto',
    forcePathStyle: true,
    // Newer SDKs add a CRC32 of the (empty) body to presigned URLs, which would make every browser upload fail.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  });
  return client;
}
