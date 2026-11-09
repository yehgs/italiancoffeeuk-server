import { Resend } from 'resend';
import { env } from './env.js';
import { logger } from './logger.js';
import { HttpError } from '../utils/httpError.js';

/**
 * Everything we can know about outgoing email *without guessing*:
 *  - static checks of the configuration,
 *  - a live question to Resend ("is this key valid, and is the MAIL_FROM domain verified in this account?"),
 *  - the real outcome of the most recent send.
 * Kept separate from mailer.js so callers can ask "can we send?" without sending.
 */

const PLACEHOLDER_DOMAINS = /(^|\.)(localhost|example\.(com|org|net)|invalid|test)$/i;
const VERIFY_TTL_MS = 5 * 60_000;
const VERIFY_TIMEOUT_MS = 5_000;
const RECENT_FAILURE_MS = 10 * 60_000;

/** Error thrown by sendMail. `info` is the plain-language explanation. */
export class MailError extends Error {
  constructor(info) {
    super(`Email could not be sent (${info.name ?? info.code}): ${info.title}`);
    this.name = 'MailError';
    this.info = info;
  }
}

export function parseFrom(from) {
  const s = String(from ?? '').trim();
  const address = (/<([^>]+)>/.exec(s)?.[1] ?? s).trim();
  const at = address.lastIndexOf('@');
  const domain = at > 0 ? address.slice(at + 1).toLowerCase() : '';
  return { address, domain, valid: at > 0 && domain.includes('.') };
}

/**
 * Turns a Resend error ({ name, message, statusCode }) into something an admin can act on.
 * `config` = true when the cause is our setup (so retrying will not help).
 */
export function describeMailError(err = {}) {
  const name = err.name ?? 'unknown_error';
  const message = String(err.message ?? '');
  const base = { name, message, statusCode: err.statusCode ?? null };
  const from = parseFrom(env.MAIL_FROM);

  if (name === 'missing_api_key' || name === 'invalid_api_key') {
    return {
      ...base, code: 'BAD_API_KEY', config: true,
      title: 'Resend does not accept the API key',
      fix: 'Create a new API key in the Resend team that owns your sending domain, set it as RESEND_API_KEY (no quotes or spaces) and redeploy.',
    };
  }
  if (name === 'restricted_api_key') {
    return {
      ...base, code: 'KEY_SENDING_ONLY', config: false,
      title: 'The API key can only send email',
      fix: 'That is fine for sending. It just means the domain cannot be checked automatically; use "Send test email" to confirm.',
    };
  }
  if (/not verified|verify your domain|domain.*(not found|isn'?t)/i.test(message) || (name === 'validation_error' && /domain/i.test(message))) {
    return {
      ...base, code: 'DOMAIN_NOT_VERIFIED', config: true,
      title: `Resend will not send from ${from.domain || 'this domain'}`,
      fix: `In the Resend team that owns this API key, verify ${from.domain || 'the domain'} (Domains page) or change MAIL_FROM to an address on a domain that is verified there.`,
    };
  }
  if (name === 'invalid_from_address' || /from.*(invalid|format)/i.test(message)) {
    return {
      ...base, code: 'BAD_FROM', config: true,
      title: 'MAIL_FROM is not a valid sender address',
      fix: 'Use the form: Italian Coffee <no-reply@italiancoffee.co.uk>',
    };
  }
  if (name === 'rate_limit_exceeded' || err.statusCode === 429) {
    return { ...base, code: 'RATE_LIMITED', config: false, title: 'Resend is rate-limiting this account', fix: 'Wait a minute and try again.' };
  }
  if (/quota/i.test(name)) {
    return { ...base, code: 'QUOTA', config: false, title: 'The Resend sending quota is used up', fix: 'Check your plan limits in the Resend dashboard.' };
  }
  if (/unable to fetch|fetch failed|ENOTFOUND|ECONN|network|timed? ?out/i.test(message)) {
    return { ...base, code: 'UNREACHABLE', config: false, title: 'The server could not reach Resend', fix: 'Check the server’s outbound network access and try again.' };
  }
  return {
    ...base, code: 'SEND_FAILED', config: false,
    title: message ? `Resend reported: ${message}` : 'Resend rejected the email',
    fix: 'See the server log line "Resend rejected the email" for the full response.',
  };
}

/* ---------- static configuration checks ---------- */

function staticChecks() {
  const checks = [];
  const t = env.MAIL_TRANSPORT;
  const from = parseFrom(env.MAIL_FROM);

  if (t === 'none') {
    checks.push({
      id: 'transport', level: 'error',
      title: 'Email sending is switched off',
      detail: 'MAIL_TRANSPORT is "none" (or not set), so no email is ever sent.',
      fix: 'Set MAIL_TRANSPORT=resend and redeploy.',
    });
  } else if (t === 'console') {
    checks.push({
      id: 'transport', level: 'warn',
      title: 'Emails are printed in the server log, not sent',
      detail: 'MAIL_TRANSPORT is "console" (development only).',
      fix: 'Set MAIL_TRANSPORT=resend to deliver real email.',
    });
  } else {
    checks.push({ id: 'transport', level: 'ok', title: 'Transport is Resend', detail: 'MAIL_TRANSPORT=resend' });
    checks.push(
      env.RESEND_API_KEY
        ? { id: 'key', level: 'ok', title: 'API key is set', detail: `RESEND_API_KEY is present (ends …${env.RESEND_API_KEY.slice(-4)}).` }
        : { id: 'key', level: 'error', title: 'API key is missing', detail: 'RESEND_API_KEY is empty.', fix: 'Set RESEND_API_KEY and redeploy.' },
    );
    if (!from.valid) {
      checks.push({ id: 'from', level: 'error', title: 'Sender address is not valid', detail: `MAIL_FROM is "${env.MAIL_FROM}".`, fix: 'Use the form: Italian Coffee <no-reply@italiancoffee.co.uk>' });
    } else if (PLACEHOLDER_DOMAINS.test(from.domain)) {
      checks.push({ id: 'from', level: 'error', title: 'Sender address is still a placeholder', detail: `MAIL_FROM uses ${from.domain}.`, fix: 'Set MAIL_FROM to an address on your verified domain.' });
    } else {
      checks.push({ id: 'from', level: 'ok', title: 'Sender address looks valid', detail: `Sending as ${from.address}.` });
    }
  }
  return checks;
}

/* ---------- live check against Resend (cached) ---------- */

let verifyCache = null; // { at, result }
let client;
const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timed out'), { name: 'timeout' })), ms).unref?.())]);

async function verifyResendDomain() {
  const from = parseFrom(env.MAIL_FROM);
  client ??= new Resend(env.RESEND_API_KEY);
  let res;
  try {
    res = await withTimeout(client.domains.list(), VERIFY_TIMEOUT_MS);
  } catch (e) {
    return { id: 'domain', level: 'warn', title: 'Could not ask Resend about your domain', detail: String(e.message ?? e), fix: 'This may be temporary network trouble. Use "Send test email" to check for real.' };
  }
  if (res?.error) {
    const info = describeMailError(res.error);
    if (info.code === 'KEY_SENDING_ONLY') {
      return { id: 'domain', level: 'warn', title: 'Domain could not be checked automatically', detail: 'The key is restricted to sending, so Resend will not list its domains.', fix: 'Use "Send test email" — it tests the real thing.' };
    }
    if (info.code === 'BAD_API_KEY') return { id: 'key', level: 'error', title: info.title, detail: `${info.name}: ${info.message}`, fix: info.fix };
    return { id: 'domain', level: 'warn', title: info.title, detail: `${info.name}: ${info.message}`, fix: info.fix };
  }
  const list = Array.isArray(res?.data) ? res.data : (res?.data?.data ?? []);
  const found = list.find((d) => String(d.name).toLowerCase() === from.domain);
  const known = list.map((d) => `${d.name} (${d.status})`).join(', ') || 'none';
  if (!found) {
    return {
      id: 'domain', level: 'error',
      title: `${from.domain} is not in the Resend team that owns this API key`,
      detail: `Domains this key can see: ${known}.`,
      fix: `Either use an API key from the Resend team where ${from.domain} is verified, or add ${from.domain} to this team.`,
    };
  }
  if (found.status !== 'verified') {
    return { id: 'domain', level: 'error', title: `${from.domain} is added but not verified (status: ${found.status})`, detail: 'Resend only sends from verified domains.', fix: 'Add the DNS records Resend shows for this domain, then press Verify in the Resend Domains page.' };
  }
  return { id: 'domain', level: 'ok', title: `${from.domain} is verified in this Resend account`, detail: `Checked live with Resend (${known}).` };
}

async function liveCheck({ force = false } = {}) {
  if (env.MAIL_TRANSPORT !== 'resend' || !env.RESEND_API_KEY || !parseFrom(env.MAIL_FROM).valid) return null;
  if (!force && verifyCache && Date.now() - verifyCache.at < VERIFY_TTL_MS) return verifyCache.result;
  const result = await verifyResendDomain();
  verifyCache = { at: Date.now(), result };
  return result;
}

/* ---------- outcome of the last real send ---------- */

let lastSend = null; // { ok, at, subject, info? }
export function recordSend({ ok, subject, info }) {
  lastSend = { ok, at: new Date().toISOString(), subject, ...(info ? { info } : {}) };
  if (!ok && info?.config) verifyCache = null; // re-check next time
}
export const getLastSend = () => lastSend;

/* ---------- public API ---------- */

export async function getMailReport({ force = false } = {}) {
  const checks = staticChecks();
  const live = await liveCheck({ force });
  if (live) {
    // A live "key rejected" replaces the optimistic "key is set" line.
    const i = checks.findIndex((c) => c.id === live.id);
    if (i >= 0) checks[i] = live; else checks.push(live);
  }
  if (lastSend) {
    checks.push(
      lastSend.ok
        ? { id: 'last', level: 'ok', title: 'Last email was accepted by Resend', detail: `“${lastSend.subject}” at ${lastSend.at}.` }
        : { id: 'last', level: 'error', title: `Last send failed: ${lastSend.info?.title ?? 'unknown error'}`, detail: `${lastSend.info?.name ?? ''} ${lastSend.info?.message ?? ''} — at ${lastSend.at}`.trim(), fix: lastSend.info?.fix },
    );
  }
  const blocking = checks.filter((c) => c.level === 'error' && c.id !== 'last');
  return {
    transport: env.MAIL_TRANSPORT,
    from: env.MAIL_FROM,
    ready: blocking.length === 0 && env.MAIL_TRANSPORT !== 'none',
    checkedAt: new Date().toISOString(),
    checks,
  };
}

/**
 * Called before accepting a password-reset request. The answer depends only on server
 * configuration (never on whether the email belongs to an account), so it reveals nothing
 * about users; it just stops the UI claiming "sent" when we know nothing can go out.
 */
export async function assertMailDeliverable() {
  const report = await getMailReport();
  let blocking = report.checks.filter((c) => c.level === 'error' && c.id !== 'last');
  if (!blocking.length && lastSend && !lastSend.ok && lastSend.info?.config && Date.now() - Date.parse(lastSend.at) < RECENT_FAILURE_MS) {
    blocking = [{ title: lastSend.info.title, fix: lastSend.info.fix }];
  }
  if (!blocking.length) return;
  throw new HttpError(
    503,
    'MAIL_UNAVAILABLE',
    'Email delivery is not working on this server, so no reset link can be sent.',
    { problems: blocking.map((c) => ({ title: c.title, fix: c.fix })) },
  );
}

/** Logged at startup so a misconfiguration is obvious in the first lines of the server log. */
export async function logMailStatus() {
  try {
    const r = await getMailReport({ force: true });
    for (const c of r.checks) {
      const line = { check: c.id, fix: c.fix };
      if (c.level === 'error') logger.error(line, `MAIL: ${c.title}. ${c.detail ?? ''}`.trim());
      else if (c.level === 'warn') logger.warn(line, `MAIL: ${c.title}. ${c.detail ?? ''}`.trim());
      else logger.info(`MAIL: ${c.title}`);
    }
    return r;
  } catch (e) {
    logger.error({ err: e.message }, 'MAIL: status check failed');
  }
}

export const __resetMailHealthForTests = () => { verifyCache = null; lastSend = null; client = undefined; };
