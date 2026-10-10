'use client'

import { useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { Sparkles, Ticket, Zap, ImageIcon, CheckCircle2, Infinity as InfinityIcon, ShieldCheck, ShieldOff, Bot, Loader2 } from 'lucide-react'
import QRCode from 'qrcode'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, logoutSession } from '../lib/api'
import type { BotQuota } from '../lib/bot'
import { AppPage } from '../components/AppPage'
import { ErrorState, LoadingState, StatCard, btnDangerOutline, btnPrimary, inputCls } from '@loop/ui'

interface Account {
  email: string
  name: string
  role: string
  plan: string
  unlimited: boolean
  credits: number
  imageCredits: number
  limits: { credits: number; imageCredits: number }
  usage: { tokensIn: number; tokensOut: number; images: number; messages: number }
  hasDb: boolean
  totpEnabled?: boolean
}

interface BillingConfig { enabled: boolean; plans: { pro: boolean; gold: boolean } }

export default function AccountPage() {
  const queryClient = useQueryClient()

  const me = useQuery<Account | null>({
    queryKey: ['account', 'me'],
    queryFn: async () => {
      try {
        return await apiFetch<Account>('/api/account/me')
      } catch {
        /* not signed in / no DB */
        return null
      }
    },
    enabled: typeof window !== 'undefined',
    retry: false,
  })
  const acct = me.data ?? null

  const billing = useQuery<BillingConfig | null>({
    queryKey: ['billing', 'config'],
    queryFn: async () => {
      try {
        return await apiFetch<BillingConfig>('/api/billing/config')
      } catch {
        return null
      }
    },
    enabled: typeof window !== 'undefined',
    retry: false,
  })

  const botQuotaQuery = useQuery<BotQuota | null>({
    queryKey: ['bot', 'quota'],
    queryFn: async () => {
      try {
        const { getBotQuota } = await import('../lib/bot')
        return await getBotQuota()
      } catch {
        /* older backend or logged out — the card hides */
        return null
      }
    },
    enabled: typeof window !== 'undefined',
    retry: false,
  })
  const botQuota = botQuotaQuery.data ?? null

  // TOTP MFA state. `enabled` seeds from the /me query; the setup wizard
  // (secret/uri/qr) is session-local, so it stays in component state.
  const [mfa, setMfa] = useState<{ enabled: boolean; secret?: string; uri?: string } | null>(null)
  const [mfaBusy, setMfaBusy] = useState(false)
  const [mfaCode, setMfaCode] = useState('')
  const [mfaQr, setMfaQr] = useState('')
  const [mfaMsg, setMfaMsg] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => {
    if (me.data) setMfa((p) => (p?.secret || p?.uri ? p : { enabled: !!me.data?.totpEnabled }))
    else if (me.isError) setMfa(null)
  }, [me.data, me.isError])

  const [code, setCode] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [checkingOut, setCheckingOut] = useState(false)

  async function startMfaSetup() {
    setMfaBusy(true); setMfaMsg(null); setMfaCode('')
    try {
      const d = await apiFetch<{ secret: string; uri: string }>('/api/account/totp/setup', { method: 'POST' })
      setMfa((p) => ({ ...(p || { enabled: false }), enabled: false, secret: d.secret, uri: d.uri }))
      setMfaQr(await QRCode.toDataURL(d.uri, { margin: 1, width: 200, color: { dark: '#e2e8f0', light: '#08080a' } }))
    } catch (e: any) { setMfaMsg({ ok: false, text: e?.message || 'Setup failed.' }) } finally { setMfaBusy(false) }
  }

  async function confirmMfa() {
    setMfaBusy(true); setMfaMsg(null)
    try {
      await apiFetch('/api/account/totp/verify', { method: 'POST', body: JSON.stringify({ token: mfaCode }) })
      setMfa({ enabled: true }); setMfaQr(''); setMfaCode('')
      setMfaMsg({ ok: true, text: 'Two-factor is on. Keep your authenticator app — you will need it at every login.' })
    } catch (e: any) { setMfaMsg({ ok: false, text: e?.message || 'That code was not accepted.' }) } finally { setMfaBusy(false) }
  }

  async function disableMfa() {
    setMfaBusy(true); setMfaMsg(null)
    try {
      await apiFetch('/api/account/totp/disable', { method: 'POST', body: JSON.stringify({ token: mfaCode }) })
      setMfa({ enabled: false }); setMfaQr(''); setMfaCode('')
      setMfaMsg({ ok: true, text: 'Two-factor is off.' })
    } catch (e: any) { setMfaMsg({ ok: false, text: e?.message || 'Enter your current code to disable.' }) } finally { setMfaBusy(false) }
  }

  const redeem = useMutation({
    mutationFn: async (voucher: string) => {
      const r = await apiFetch<{ applied?: { unlimited?: boolean; credits?: number; imageCredits?: number; plan?: string } }>('/api/account/redeem', {
        method: 'POST',
        body: JSON.stringify({ code: voucher }),
      })
      return r.applied || {}
    },
    onSuccess: (a) => {
      setMsg({
        ok: true,
        text: a.unlimited
          ? 'Unlimited team access unlocked! 🎉'
          : `Redeemed: ${a.credits ? `+${a.credits} credits ` : ''}${a.imageCredits ? `+${a.imageCredits} image credits ` : ''}${a.plan ? `(${a.plan} plan)` : ''}`.trim(),
      })
      setCode('')
      void queryClient.invalidateQueries({ queryKey: ['account', 'me'] })
    },
    onError: (err: any) => { setMsg({ ok: false, text: err?.message || 'Could not redeem voucher.' }) },
  })

  async function upgrade(plan: string) {
    setCheckingOut(true)
    try {
      const r = await apiFetch<{ url: string }>('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ plan }) })
      if (r.url) window.location.href = r.url
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not start checkout.' })
      setCheckingOut(false)
    }
  }

  function onRedeem(e: FormEvent) {
    e.preventDefault()
    if (!code.trim() || redeem.isPending) return
    redeem.mutate(code)
  }

  const fmt = (n: number) => (n === Infinity || !Number.isFinite(n) ? '∞' : n.toLocaleString())
  const loading = me.isPending

  return (
    <AppPage title="Account & Billing" documentTitle="Account" back={{ href: '/chat', label: 'Chat' }}>
      {loading ? (
        <LoadingState label="Loading account" />
      ) : (
        <>
          <p className="text-sm text-[var(--ink-muted)] mb-6">
            {acct ? <>Signed in as <span className="text-[var(--ink-secondary)]">{acct.email}</span></> : 'Guest session'}
            {acct?.unlimited && <span className="ml-2 inline-flex items-center gap-1 text-ui-xs text-[var(--accent-text)] bg-[var(--accent-soft)] border border-[var(--accent-soft-border)] rounded-full px-2 py-0.5"><InfinityIcon size={11} aria-hidden /> Unlimited</span>}
            {acct?.role === 'admin' && <Link href="/admin" className="ml-2 text-ui-xs text-[var(--accent-text)] hover:underline">Admin portal →</Link>}
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
            <StatCard icon={<Zap size={13} aria-hidden />} label="Message credits" value={acct?.unlimited ? '∞' : fmt(acct?.credits ?? Infinity)} sub={acct && !acct.unlimited ? `of ${acct.limits.credits}/day` : 'unlimited'} />
            <StatCard icon={<ImageIcon size={13} aria-hidden />} label="Image credits" value={acct?.unlimited ? '∞' : fmt(acct?.imageCredits ?? Infinity)} sub={acct && !acct.unlimited ? `of ${acct.limits.imageCredits}/day` : 'unlimited'} />
            <StatCard icon={<Sparkles size={13} aria-hidden />} label="Plan" value={(acct?.plan || 'free').toUpperCase()} />
            <StatCard icon={<Zap size={13} aria-hidden />} label="Messages sent" value={fmt(acct?.usage.messages ?? 0)} sub={`${fmt(acct?.usage.images ?? 0)} images`} />
          </div>

          {/* Loop Bot computer minutes — the separate daily VM budget. */}
          {botQuota && (
            <Link href="/agents" className="glass rounded-xl p-4 mb-8 flex items-center gap-3 hover:border-[var(--border-strong)] transition group">
              <div className="w-8 h-8 rounded-lg bg-[var(--accent-soft)] flex items-center justify-center shrink-0">
                <Bot size={15} className="text-[var(--accent-text)]" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-ui-xs text-[var(--ink-muted)]">Loop Bot computer</div>
                <div className="text-ui-md font-semibold text-[var(--ink-primary)]">
                  {botQuota.unlimited ? 'Unlimited' : `${botQuota.remaining ?? 0} min left`}
                  <span className="ml-1.5 text-ui-xs font-normal text-[var(--ink-muted)]">{botQuota.unlimited ? '' : `of ${botQuota.cap}/day`}</span>
                </div>
              </div>
              {!botQuota.unlimited && botQuota.cap !== null && botQuota.cap > 0 && (
                <div className="h-1.5 w-20 rounded-full bg-[var(--bg-hover)] overflow-hidden shrink-0" aria-hidden>
                  <div className="h-full rounded-full bg-[var(--accent-fill)]" style={{ width: `${Math.max(2, Math.round(((botQuota.remaining ?? 0) / botQuota.cap) * 100))}%` }} />
                </div>
              )}
              <span className="text-ui-xs text-[var(--ink-muted)] group-hover:text-[var(--ink-secondary)] transition shrink-0">Open →</span>
            </Link>
          )}

          {/* Voucher redeem */}
          <div className="glass-strong rounded-2xl p-5 mb-6">
            <div className="flex items-center gap-2 mb-1 text-[var(--ink-primary)] font-medium"><Ticket size={16} className="text-[var(--accent-text)]" aria-hidden /> Redeem a voucher</div>
            <p className="text-ui-xs text-[var(--ink-muted)] mb-3">Have a team or promo code? Unlock unlimited access or top up credits.</p>
            <form onSubmit={onRedeem} className="flex gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="LOOP-XXXXX-XXXXX"
                className={`${inputCls} font-mono tracking-wide`}
              />
              <button type="submit" disabled={redeem.isPending} className={btnPrimary}>
                {redeem.isPending ? <Loader2 size={15} className="animate-spin" aria-hidden /> : 'Redeem'}
              </button>
            </form>
            {msg && (
              <div className={`mt-3 text-ui-xs rounded-lg px-3 py-2 flex items-center gap-2 border ${msg.ok ? 'text-[var(--success)] bg-[var(--bg-tint)] border-[var(--border-subtle)]' : 'text-[var(--danger)] bg-[var(--danger-soft)] border-[var(--danger-soft-border)]'}`} role="status">
                {msg.ok && <CheckCircle2 size={13} aria-hidden />} {msg.text}
              </div>
            )}
          </div>

          {/* Two-factor authentication (TOTP MFA) */}
          <div className="glass-strong rounded-2xl p-5 mb-6">
            <div className="flex items-center gap-2 mb-1 text-[var(--ink-primary)] font-medium">
              {mfa?.enabled ? <ShieldCheck size={16} className="text-[var(--success)]" aria-hidden /> : <ShieldOff size={16} className="text-[var(--ink-muted)]" aria-hidden />}
              Two-factor authentication
            </div>
            <p className="text-ui-xs text-[var(--ink-muted)] mb-3">
              {mfa?.enabled
                ? 'On — every login also asks for a 6-digit code from your authenticator app.'
                : 'Add a second factor: scan the QR with Google Authenticator, 1Password, Authy, or any TOTP app.'}
            </p>

            {mfa?.enabled ? (
              <div className="flex gap-2 max-w-xs">
                <input
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
                  inputMode="numeric" maxLength={6} placeholder="Current code"
                  className={`${inputCls} font-mono tracking-[0.25em]`}
                  aria-label="Current authenticator code"
                />
                <button type="button" onClick={disableMfa} disabled={mfaBusy || mfaCode.length !== 6} className={btnDangerOutline}>
                  {mfaBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : 'Disable'}
                </button>
              </div>
            ) : mfa?.secret && mfa.uri ? (
              <div className="flex flex-col sm:flex-row gap-4 items-start">
                {mfaQr && <img src={mfaQr} alt="TOTP QR code" className="rounded-xl border border-[var(--border-subtle)]" width={160} height={160} />}
                <div className="flex-1 space-y-2 min-w-0">
                  <p className="text-2xs text-[var(--ink-muted)]">Can&apos;t scan? Enter this key manually:</p>
                  <code className="block text-ui-xs font-mono text-[var(--ink-secondary)] bg-[var(--bg-code)] border border-[var(--border-subtle)] rounded-lg px-2.5 py-1.5 break-all select-all">{mfa.secret}</code>
                  <div className="flex gap-2">
                    <input
                      value={mfaCode}
                      onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
                      inputMode="numeric" maxLength={6} placeholder="6-digit code"
                      className={`${inputCls} font-mono tracking-[0.25em]`}
                      aria-label="Verification code"
                    />
                    <button type="button" onClick={confirmMfa} disabled={mfaBusy || mfaCode.length !== 6} className={btnPrimary}>
                      {mfaBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : 'Verify & enable'}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <button type="button" onClick={startMfaSetup} disabled={mfaBusy} className={btnPrimary}>
                {mfaBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : 'Set up two-factor'}
              </button>
            )}
            {mfaMsg && (
              <div className={`mt-3 text-ui-xs rounded-lg px-3 py-2 border ${mfaMsg.ok ? 'text-[var(--success)] bg-[var(--bg-tint)] border-[var(--border-subtle)]' : 'text-[var(--danger)] bg-[var(--danger-soft)] border-[var(--danger-soft-border)]'}`} role="status">
                {mfaMsg.text}
              </div>
            )}
          </div>

          {/* Upgrade CTA */}
          {acct && !acct.unlimited && acct.plan !== 'pro' && acct.plan !== 'gold' && (
            <div className="glass rounded-2xl p-5 flex items-center justify-between">
              <div>
                <div className="text-[var(--ink-primary)] font-medium">Upgrade to Pro</div>
                <div className="text-ui-xs text-[var(--ink-muted)]">1,000 messages + 100 images per day, priority speed.</div>
              </div>
              {billing.data?.enabled && billing.data.plans.pro ? (
                <button type="button" onClick={() => void upgrade('pro')} disabled={checkingOut} className={btnPrimary}>
                  {checkingOut ? <Loader2 size={15} className="animate-spin" aria-hidden /> : 'Upgrade'}
                </button>
              ) : (
                <Link href="/#pricing" className={btnPrimary}>See plans</Link>
              )}
            </div>
          )}

          {acct && (
            <button type="button" onClick={() => { logoutSession(); location.href = '/login' }} className="mt-8 text-ui-xs text-[var(--ink-muted)] hover:text-[var(--danger)] transition">Sign out</button>
          )}
        </>
      )}
    </AppPage>
  )
}
