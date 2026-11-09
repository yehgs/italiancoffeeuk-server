// Usage: npm run mail:test -- you@example.com
// Uses the same MAIL_* settings as the server (from .env or the environment) and prints Resend's real answer.
import { logMailStatus } from '../src/config/mailHealth.js';
import { sendMail } from '../src/config/mailer.js';

const to = process.argv[2];
if (!to) { console.error('Usage: npm run mail:test -- you@example.com'); process.exit(2); }
const report = await logMailStatus();
for (const c of report?.checks ?? []) console.log(`${{ ok: '✓', warn: '!', error: '✗' }[c.level]} ${c.title}${c.detail ? ` — ${c.detail}` : ''}${c.fix ? `\n    fix: ${c.fix}` : ''}`);
try {
  const r = await sendMail({ to, subject: 'Italian Coffee: email test', text: 'Test message. If you can read this, email delivery works.' });
  console.log(r?.skipped ? '✗ Nothing sent: MAIL_TRANSPORT is "none".' : `✓ Accepted by the mail transport${r?.id ? ` (id ${r.id})` : ''}. Check ${to}.`);
} catch (e) {
  console.error(`✗ ${e.message}\n  fix: ${e.info?.fix ?? 'see log above'}`);
  process.exitCode = 1;
}
setTimeout(() => process.exit(), 200);
