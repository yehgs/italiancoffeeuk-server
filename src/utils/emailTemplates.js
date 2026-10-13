const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function layout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f6f1ec;font-family:Arial,Helvetica,sans-serif;color:#2b1d14">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:520px;background:#fff;border-radius:12px;padding:28px">
<tr><td><h1 style="font-size:20px;margin:0 0 16px;color:#503225">${esc(title)}</h1>${bodyHtml}
<p style="font-size:12px;color:#8a7a70;margin:24px 0 0">Italian Coffee UK</p></td></tr></table></td></tr></table></body></html>`;
}

export function resetPasswordEmail({ firstName, link }) {
  return {
    subject: 'Reset your Italian Coffee password',
    text: `Hello ${firstName},\n\nUse the link below to choose a new password. It expires in 1 hour.\n\n${link}\n\nIf you did not request this, you can ignore this email.`,
    html: layout('Reset your password', `<p>Hello ${esc(firstName)},</p>
<p>Use the button below to choose a new password. The link expires in 1 hour.</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#503225;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px">Choose a new password</a></p>
<p style="font-size:13px;color:#6b5a50">If the button does not work, copy this link:<br>${esc(link)}</p>
<p style="font-size:13px;color:#6b5a50">If you did not request this, you can ignore this email.</p>`),
  };
}

export function passwordChangedEmail({ firstName }) {
  return {
    subject: 'Your Italian Coffee password was changed',
    text: `Hello ${firstName},\n\nThe password on your account was just changed and other devices were signed out.\n\nIf this was not you, reset your password immediately using "Forgot password" and contact us.`,
    html: layout('Your password was changed', `<p>Hello ${esc(firstName)},</p>
<p>The password on your account was just changed and other devices were signed out.</p>
<p>If this was not you, use <strong>Forgot password</strong> right away and contact us.</p>`),
  };
}
