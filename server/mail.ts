import { SAFETY, SITE_NAME } from '../shared/config.js';
import { env } from './env.js';

/**
 * Outbound email/SMS behind one small interface, so a provider can be swapped
 * without touching the auth code.
 *   MAIL_ADAPTER=console  codes are written to the server log (development)
 *   MAIL_ADAPTER=resend   real email through resend.com (needs RESEND_API_KEY and a verified domain)
 */
export interface Messenger {
  sendEmailCode(to: string, code: string): Promise<void>;
  /** "Sign in by <date> or your account will be deleted." */
  sendInactivityWarning(to: string, handle: string, deleteOn: Date): Promise<void>;
  sendSmsCode(to: string, code: string): Promise<void>;
}

/** Sending failed; the message is safe to show the member. */
export class MailError extends Error {}

const consoleMessenger: Messenger = {
  async sendEmailCode(to, code) {
    console.log(`[mail] verification code for ${to}: ${code}`);
  },
  async sendInactivityWarning(to, handle, deleteOn) {
    console.log(`[mail] inactivity warning for ${handle} <${to}>: deleting on ${deleteOn.toDateString()}`);
  },
  async sendSmsCode(to, code) {
    console.log(`[sms] verification code for ${to}: ${code}`);
  },
};

function codeEmail(code: string): { subject: string; text: string; html: string } {
  const mins = SAFETY.verificationCodeMinutes;
  const subject = `${code} is your ${SITE_NAME} code`;
  const text = `Your ${SITE_NAME} confirmation code is ${code}\n\nIt works for ${mins} minutes. If you didn't sign up for ${SITE_NAME}, you can ignore this email.`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f6;font-family:Arial,Helvetica,sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#fff;border:2px solid #d10a1e;border-radius:12px">
<tr><td style="padding:22px 24px 8px;font-size:20px;font-weight:800;color:#d10a1e">${SITE_NAME}</td></tr>
<tr><td style="padding:4px 24px 0;font-size:16px">Your confirmation code:</td></tr>
<tr><td style="padding:14px 24px"><div style="font-size:34px;font-weight:800;letter-spacing:8px;font-family:'Courier New',monospace;background:#fff1f2;border:2px dashed #d10a1e;border-radius:8px;padding:10px 0;text-align:center">${code}</div></td></tr>
<tr><td style="padding:0 24px 22px;font-size:14px;color:#555">It works for ${mins} minutes. If you didn't sign up for ${SITE_NAME}, you can ignore this email.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

function warningEmail(handle: string, deleteOn: Date): { subject: string; text: string; html: string } {
  const day = deleteOn.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const subject = `Your ${SITE_NAME} account will be deleted on ${day}`;
  const text = `Hi ${handle},\n\nYou haven't signed in to ${SITE_NAME} for almost two years. Accounts that stay inactive for two years are deleted with all their data.\n\nTo keep your account, just sign in before ${day}: https://roleplayretro.com/login\n\nIf you don't need it any more, you don't have to do anything.`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f6;font-family:Arial,Helvetica,sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#fff;border:2px solid #d10a1e;border-radius:12px">
<tr><td style="padding:22px 24px 8px;font-size:20px;font-weight:800;color:#d10a1e">${SITE_NAME}</td></tr>
<tr><td style="padding:4px 24px 0;font-size:16px">Hi ${esc(handle)},</td></tr>
<tr><td style="padding:12px 24px 0;font-size:15px">You haven't signed in for almost two years. Inactive accounts are deleted with all their data after two years.</td></tr>
<tr><td style="padding:12px 24px 0;font-size:15px">To keep yours, sign in before <strong>${day}</strong>.</td></tr>
<tr><td style="padding:16px 24px"><a href="https://roleplayretro.com/login" style="display:inline-block;background:#d10a1e;color:#fff;text-decoration:none;font-weight:800;padding:10px 18px;border-radius:8px">Sign in</a></td></tr>
<tr><td style="padding:0 24px 22px;font-size:13px;color:#555">If you don't need your account any more, you don't have to do anything.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

async function resendSend(to: string, mail: { subject: string; text: string; html: string }): Promise<void> {
  let res: Response;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.mailFrom, to: [to], subject: mail.subject, text: mail.text, html: mail.html }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error('[mail] could not reach Resend:', (e as Error).message);
    throw new MailError("We couldn't send the email just now. Try again in a minute.");
  }
  if (!res.ok) {
    const why = await res.text().catch(() => '');
    console.error(`[mail] Resend refused the email (${res.status}): ${why.slice(0, 300)}`);
    throw new MailError("We couldn't send the email just now. Try again in a minute.");
  }
}

const resendMessenger: Messenger = {
  async sendInactivityWarning(to, handle, deleteOn) {
    await resendSend(to, warningEmail(handle, deleteOn));
  },
  async sendEmailCode(to, code) {
    const mail = codeEmail(code);
    let res: Response;
    try {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.mailFrom, to: [to], subject: mail.subject, text: mail.text, html: mail.html }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      console.error('[mail] could not reach Resend:', (e as Error).message);
      throw new MailError("We couldn't send the email just now. Try again in a minute.");
    }
    if (!res.ok) {
      // Log the provider's reason (never the code or key) so setup problems are easy to spot.
      const why = await res.text().catch(() => '');
      console.error(`[mail] Resend refused the email (${res.status}): ${why.slice(0, 300)}`);
      throw new MailError("We couldn't send the email just now. Try again in a minute.");
    }
  },
  async sendSmsCode(to, code) {
    return consoleMessenger.sendSmsCode(to, code); // no SMS provider yet
  },
};

let warned = false;
export function messenger(): Messenger {
  switch (env.mailAdapter) {
    case 'console':
      return consoleMessenger;
    case 'resend':
      if (env.resendApiKey) return resendMessenger;
      if (!warned) { warned = true; console.error('[mail] MAIL_ADAPTER=resend but RESEND_API_KEY is not set: codes go to the log.'); }
      return consoleMessenger;
    default:
      throw new Error(`Unknown MAIL_ADAPTER "${env.mailAdapter}". Add an adapter in server/mail.ts.`);
  }
}
