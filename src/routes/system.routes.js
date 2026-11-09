import { Router } from 'express';
import { requireSuperAdmin } from '../middleware/authenticate.js';
import { sendMail } from '../config/mailer.js';
import { getMailReport } from '../config/mailHealth.js';
import { HttpError } from '../utils/httpError.js';
import { ok } from '../utils/respond.js';

const router = Router();
router.use(requireSuperAdmin);

// Live status of outgoing email: configuration, a real question to Resend, and the last send's outcome.
router.get('/mail', async (req, res) => ok(res, await getMailReport({ force: req.query.refresh === '1' })));

// Sends a real test email to the signed-in admin and reports Resend's actual answer.
router.post('/mail/test', async (req, res) => {
  const to = req.auth.subject.email;
  try {
    const sent = await sendMail({
      to,
      subject: 'Italian Coffee: email test',
      text: 'This is a test message from the Italian Coffee admin. If you can read it, email delivery works.',
    });
    if (sent?.skipped) throw new HttpError(409, 'MAIL_DISABLED', 'Email sending is switched off (MAIL_TRANSPORT=none). Set MAIL_TRANSPORT=resend and redeploy.', { report: await getMailReport() });
    ok(res, { sent: true, to, id: sent?.id ?? null, report: await getMailReport() });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const info = err.info ?? { title: err.message };
    throw new HttpError(502, 'MAIL_SEND_FAILED', info.title, { ...info, report: await getMailReport() });
  }
});

export default router;
