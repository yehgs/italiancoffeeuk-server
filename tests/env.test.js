import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

const base = { DATABASE_URL: 'mongodb://x/y' };
describe('env validation', () => {
  it('requires DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
  it('applies safe defaults', () => {
    const e = loadEnv(base);
    expect(e.COOKIE_SAMESITE).toBe('lax');
    expect(e.corsOrigins).toEqual(['http://localhost:3000']);
    expect(e.MAIL_TRANSPORT).toBe('none');
  });
  it('refuses the console mail transport in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', MAIL_TRANSPORT: 'console' })).toThrow(/console/);
  });
  it('parses multiple CORS origins', () => {
    expect(loadEnv({ ...base, CORS_ORIGINS: 'https://a.com, https://b.com' }).corsOrigins).toEqual(['https://a.com', 'https://b.com']);
  });
  it('rejects weak bootstrap passwords', () => {
    expect(() => loadEnv({ ...base, BOOTSTRAP_ADMIN_EMAIL: 'a@b.co', BOOTSTRAP_ADMIN_PASSWORD: 'short' })).toThrow();
  });
});
