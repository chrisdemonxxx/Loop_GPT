/**
 * Transactional email via SMTP (nodemailer). Env-gated: when SMTP_* is not
 * configured, every send is a logged no-op so the app runs fine without mail.
 *
 * Configure with:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE (true|false),
 *   MAIL_FROM (e.g. "Loop GPT <no-reply@loop-gpt.cyou>")
 *
 * Inbound mail (replies/alerts received) is handled by POST /api/mail/inbound —
 * point an inbound provider (SES/Mailgun/Postmark route) or your MX webhook there.
 */
import nodemailer, { type Transporter } from 'nodemailer'

let transporter: Transporter | null = null
let configured = false

function init() {
  if (configured) return
  configured = true
  const host = process.env.SMTP_HOST
  if (!host) {
    console.log('[email] SMTP not configured — emails will be logged, not sent.')
    return
  }
  transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  })
}

export const emailEnabled = () => !!process.env.SMTP_HOST

const FROM = () => process.env.MAIL_FROM || 'Loop GPT <no-reply@loop-gpt.cyou>'
const APP = () => process.env.FRONTEND_URL || 'https://loop-gpt.cyou'

/** Send an email. Never throws — returns false on failure so callers can ignore. */
export async function sendMail(to: string, subject: string, html: string, text?: string): Promise<boolean> {
  init()
  if (!transporter) {
    console.log(`[email] (no SMTP) would send to ${to}: ${subject}`)
    return false
  }
  try {
    await transporter.sendMail({ from: FROM(), to, subject, html, text: text || html.replace(/<[^>]+>/g, ' ') })
    return true
  } catch (e: any) {
    console.error('[email] send failed:', e?.message)
    return false
  }
}

function shell(title: string, body: string): string {
  return `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;background:#0b0b12;color:#e2e8f0;border-radius:16px;overflow:hidden;border:1px solid #1e1e2e">
    <div style="padding:22px 24px;background:linear-gradient(135deg,#7c3aed,#06b6d4)"><span style="font-weight:700;font-size:18px;color:#fff">Loop GPT</span></div>
    <div style="padding:24px">
      <h1 style="font-size:18px;margin:0 0 12px">${title}</h1>
      <div style="font-size:14px;line-height:1.6;color:#cbd5e1">${body}</div>
      <div style="margin-top:22px"><a href="${APP()}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-size:14px">Open Loop GPT</a></div>
    </div>
    <div style="padding:14px 24px;border-top:1px solid #1e1e2e;font-size:11px;color:#64748b">You're receiving this because you have a Loop GPT account.</div>
  </div>`
}

export function welcomeEmail(to: string, name: string) {
  return sendMail(to, 'Welcome to Loop GPT 🎉', shell('Welcome aboard, ' + (name || 'there') + '!',
    'Your account is ready. You can chat with the agent, run deep research, generate images and documents, and connect your own tools.<br><br>You start on the free plan — redeem a voucher in <b>Account</b> to unlock more.'))
}

export function voucherRedeemedEmail(to: string, name: string, summary: string) {
  return sendMail(to, 'Voucher redeemed ✅', shell('Nice, ' + (name || 'there') + '!',
    `Your voucher was applied: <b>${summary}</b>.<br><br>Enjoy your upgraded access.`))
}

export function lowCreditEmail(to: string, name: string, remaining: number) {
  return sendMail(to, 'You’re running low on credits', shell('Heads up, ' + (name || 'there'),
    `You have <b>${remaining}</b> message credits left today. They reset every 24h — or upgrade for more.`))
}

export function alertEmail(to: string, subject: string, message: string) {
  return sendMail(to, subject, shell(subject, message))
}

export function verifyEmail(to: string, name: string, link: string) {
  return sendMail(to, 'Verify your email', shell('Confirm your email, ' + (name || 'there'),
    `Please verify your email address to secure your account.<br><br><a href="${link}" style="color:#7c3aed">Verify my email →</a><br><br>Or paste this link: ${link}<br><br>This link expires in 24 hours.`))
}

export function resetPasswordEmail(to: string, name: string, link: string) {
  return sendMail(to, 'Reset your password', shell('Password reset',
    `We received a request to reset your Loop GPT password.<br><br><a href="${link}" style="color:#7c3aed">Choose a new password →</a><br><br>Or paste this link: ${link}<br><br>This link expires in 1 hour. If you didn't request this, you can ignore this email.`))
}
