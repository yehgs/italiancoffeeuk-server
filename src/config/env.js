import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Comma-separated list of exact browser origins allowed to call the API.
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  // Public URL of the storefront; used to build password-reset links.
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),

  COOKIE_NAME: z.string().default('ic_session'),
  // Use "none" when the API and the site are on different registrable domains
  // (requires HTTPS); "lax" when they share one (e.g. api.example.com + example.com).
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_DOMAIN: z.string().optional(),
  CUSTOMER_SESSION_HOURS: z.coerce.number().positive().default(24 * 7),
  ADMIN_SESSION_HOURS: z.coerce.number().positive().default(12),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  // Cloudflare R2 (S3-compatible). Uploads are disabled until all of these are set.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  // Public base URL of the bucket, e.g. https://media.example.com (custom domain) or the r2.dev URL.
  R2_PUBLIC_BASE_URL: z.string().url().optional(),
  R2_KEY_PREFIX: z.string().default('italiancoffee'),

  // "resend" sends real mail through Resend; "console" logs it (development only); "none" sends nothing.
  MAIL_TRANSPORT: z.enum(['resend', 'console', 'none']).default('none'),
  RESEND_API_KEY: z.string().optional(),
  MAIL_REPLY_TO: z.string().email().optional(),
  MAIL_FROM: z.string().default('Italian Coffee <no-reply@localhost>'),

  // Optional bootstrap so the first super-admin can exist without Firestore data.
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),

  SEED_REFERENCE_DATA: bool.default(false),
});

export function loadEnv(source = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const env = parsed.data;

  if (env.COOKIE_SAMESITE === 'none' && env.NODE_ENV !== 'production') {
    // SameSite=None requires Secure; browsers reject it on plain http.
    env.warnings = ['COOKIE_SAMESITE=none needs HTTPS; it will not work on http://localhost'];
  }
  if (env.MAIL_TRANSPORT === 'resend' && !env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is required when MAIL_TRANSPORT=resend');
  }
  if (env.NODE_ENV === 'production' && env.MAIL_TRANSPORT === 'console') {
    throw new Error('MAIL_TRANSPORT=console is not allowed in production');
  }
  env.corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  env.isProd = env.NODE_ENV === 'production';
  return env;
}

let cached;
export const env = new Proxy(
  {},
  {
    get(_t, key) {
      cached ??= loadEnv();
      return cached[key];
    },
  },
);
export function resetEnvCache() {
  cached = undefined;
}
