'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Sparkles, Ticket, Zap, ImageIcon, ArrowLeft, Loader2, CheckCircle2, Infinity as InfinityIcon, ShieldCheck, ShieldOff } from 'lucide-react'
import QRCode from 'qrcode'
import { apiFetch, clearAuth } from '../lib/api'

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
}

function StatCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="glass rounded-xl p-4 flex flex-col gap-1">
      <div className="flex items-center gap-2 text-slate-400 text-xs">{icon}{label}</div>
      <div className="text-2xl font-semibold text-slate-100">{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  )
}

export default function AccountPage() {
  const [acct, setAcct] = useState<Account | null>(null)
  const [loading, setLoading] = useState(true)
  const [code, setCode] = useState('')
  const [redeeming, setRedeeming] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [billing, setBilling] = useState<{ enabled: boolean; plans: { pro: boolean; gold: boolean } } | null>(null)
  const [checkingOut, setCheckingOut] = useState(false)

  // TOTP MFA state.
  const [mfa, setMfa] = useState<{ enabled: boolean; secret?: string; uri?: string } | null>(null)
  const [mfaBusy, setMfaBusy] = useState(false)
  const [mfaCode, setMfaCode] = useState('')
  const [mfaQr, setMfaQr] = useState('')
  const [mfaMsg, setMfaMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    apiFetch<any>('/api/account/me').then((a) => setMfa({ enabled: !!a.totpEnabled })).catch(() => setMfa(null))
  }, [])

  async function startMfaSetup() {
    setMfaBusy(true); setMfaMsg(null); setMfaCode('')
    try {
      const d = await apiFetch<{ secret: string; uri: string }>('/api/account/totp/setup', { method: 'POST' })
      setMfa((p) => ({ ...(p || { enabled: false }), enabled: false, secret: d.secret, uri: d.uri }))
      setMfaQr(await QRCode.toDataURL(d.uri, { margin: 1, width: 200, color: { dark: '#e2e8f0', light: '#111113' } }))
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

  useEffect(() => {
    apiFetch<{ enabled: boolean; plans: any }>('/api/billing/config').then(setBilling).catch(() => setBilling(null))
  }, [])

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

  async function load() {
    try {
      setAcct(await apiFetch<Account>('/api/account/me'))
    } catch {
      /* not signed in / no DB */
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [])

  async function redeem(e: React.FormEvent) {
    e.preventDefault()
    if (!code.trim()) return
    setRedeeming(true)
    setMsg(null)
    try {
      const r = await apiFetch<{ applied?: any }>('/api/account/redeem', {
        method: 'POST',
        body: JSON.stringify({ code }),
      })
      const a = r.applied || {}
      setMsg({
        ok: true,
        text: a.unlimited
          ? 'Unlimited team access unlocked! 🎉'
          : `Redeemed: ${a.credits ? `+${a.credits} credits ` : ''}${a.imageCredits ? `+${a.imageCredits} image credits ` : ''}${a.plan ? `(${a.plan} plan)` : ''}`.trim(),
      })
      setCode('')
      load()
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Could not redeem voucher.' })
    } finally {
      setRedeeming(false)
    }
  }

  const fmt = (n: number) => (n === Infinity || !Number.isFinite(n) ? '∞' : n.toLocaleString())

  return (
    <div className="min-h-screen px-5 py-8 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <Link href="/chat" className="flex items-center gap-2 text-slate-400 hover:text-slate-200 text-sm">
          <ArrowLeft size={16} /> Back to chat
        </Link>
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#c96442] to-[#d8a08a] flex items-center justify-center shadow-glow"><Sparkles size={14} className="text-white" /></div>
          <span className="font-semibold text-gradient">Loop GPT</span>
        </div>
      </div>

      <h1 className="text-2xl font-semibold text-slate-100 mb-1">Account & Billing</h1>
      {loading ? (
        <div className="flex items-center gap-2 text-slate-500 mt-6"><Loader2 size={16} className="animate-spin" /> Loading…</div>
      ) : (
        <>
          <p className="text-sm text-slate-500 mb-6">
            {acct ? <>Signed in as <span className="text-slate-300">{acct.email}</span></> : 'Guest session'}
            {acct?.unlimited && <span className="ml-2 inline-flex items-center gap-1 text-xs text-[#d8a08a] bg-[#d8a08a]/10 border border-[#d8a08a]/20 rounded-full px-2 py-0.5"><InfinityIcon size={11} /> Unlimited</span>}
            {acct?.role === 'admin' && <Link href="/admin" className="ml-2 text-xs text-[#c96442] hover:underline">Admin portal →</Link>}
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
            <StatCard icon={<Zap size={13} />} label="Message credits" value={acct?.unlimited ? '∞' : fmt(acct?.credits ?? Infinity)} sub={acct && !acct.unlimited ? `of ${acct.limits.credits}/day` : 'unlimited'} />
            <StatCard icon={<ImageIcon size={13} />} label="Image credits" value={acct?.unlimited ? '∞' : fmt(acct?.imageCredits ?? Infinity)} sub={acct && !acct.unlimited ? `of ${acct.limits.imageCredits}/day` : 'unlimited'} />
            <StatCard icon={<Sparkles size={13} />} label="Plan" value={(acct?.plan || 'free').toUpperCase()} />
            <StatCard icon={<Zap size={13} />} label="Messages sent" value={fmt(acct?.usage.messages ?? 0)} sub={`${fmt(acct?.usage.images ?? 0)} images`} />
          </div>

          {/* Voucher redeem */}
          <div className="glass-strong rounded-2xl p-5 mb-6">
            <div className="flex items-center gap-2 mb-1 text-slate-100 font-medium"><Ticket size={16} className="text-[#c96442]" /> Redeem a voucher</div>
            <p className="text-xs text-slate-500 mb-3">Have a team or promo code? Unlock unlimited access or top up credits.</p>
            <form onSubmit={redeem} className="flex gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="LOOP-XXXXX-XXXXX"
                className="flex-1 bg-ink-800 border border-white/10 rounded-lg px-3 py-2.5 text-slate-100 text-sm font-mono tracking-wide focus:outline-none focus:accent-ring placeholder-slate-600"
              />
              <button type="submit" disabled={redeeming} className="px-4 rounded-lg text-white bg-gradient-to-r from-[#c96442] to-[#b5593a] hover:opacity-90 disabled:opacity-50 transition shadow-glow font-medium text-sm flex items-center gap-2">
                {redeeming ? <Loader2 size={15} className="animate-spin" /> : 'Redeem'}
              </button>
            </form>
            {msg && (
              <div className={`mt-3 text-xs rounded-lg px-3 py-2 flex items-center gap-2 ${msg.ok ? 'text-emerald-400 bg-emerald-500/10 border border-emerald-500/20' : 'text-rose-400 bg-rose-500/10 border border-rose-500/20'}`}>
                {msg.ok && <CheckCircle2 size={13} />} {msg.text}
              </div>
            )}
          </div>

          {/* Two-factor authentication (TOTP MFA) */}
          <div className="glass-strong rounded-2xl p-5 mb-6">
            <div className="flex items-center gap-2 mb-1 text-slate-100 font-medium">
              {mfa?.enabled ? <ShieldCheck size={16} className="text-emerald-400" /> : <ShieldOff size={16} className="text-slate-500" />}
              Two-factor authentication
            </div>
            <p className="text-xs text-slate-500 mb-3">
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
                  className="flex-1 bg-ink-800 border border-white/10 rounded-lg px-3 py-2.5 text-slate-100 text-sm font-mono tracking-[0.25em] focus:outline-none focus:accent-ring placeholder-slate-600"
                  aria-label="Current authenticator code"
                />
                <button onClick={disableMfa} disabled={mfaBusy || mfaCode.length !== 6} className="px-4 rounded-lg text-rose-300 border border-rose-500/30 hover:bg-rose-500/10 disabled:opacity-40 transition text-sm">
                  {mfaBusy ? <Loader2 size={14} className="animate-spin" /> : 'Disable'}
                </button>
              </div>
            ) : mfa?.secret && mfa.uri ? (
              <div className="flex flex-col sm:flex-row gap-4 items-start">
                {mfaQr && <img src={mfaQr} alt="TOTP QR code" className="rounded-xl border border-white/10" width={160} height={160} />}
                <div className="flex-1 space-y-2 min-w-0">
                  <p className="text-[11px] text-slate-500">Can&apos;t scan? Enter this key manually:</p>
                  <code className="block text-[12px] font-mono text-slate-300 bg-ink-800 border border-white/10 rounded-lg px-2.5 py-1.5 break-all select-all">{mfa.secret}</code>
                  <div className="flex gap-2">
                    <input
                      value={mfaCode}
                      onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
                      inputMode="numeric" maxLength={6} placeholder="6-digit code"
                      className="flex-1 bg-ink-800 border border-white/10 rounded-lg px-3 py-2.5 text-slate-100 text-sm font-mono tracking-[0.25em] focus:outline-none focus:accent-ring placeholder-slate-600"
                      aria-label="Verification code"
                    />
                    <button onClick={confirmMfa} disabled={mfaBusy || mfaCode.length !== 6} className="px-4 rounded-lg text-white bg-[#c96442] hover:bg-[#b5593a] disabled:opacity-40 transition text-sm font-medium">
                      {mfaBusy ? <Loader2 size={14} className="animate-spin" /> : 'Verify & enable'}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <button onClick={startMfaSetup} disabled={mfaBusy} className="px-4 py-2 rounded-lg text-white bg-[#c96442] hover:bg-[#b5593a] disabled:opacity-40 transition text-sm font-medium">
                {mfaBusy ? <Loader2 size={14} className="animate-spin" /> : 'Set up two-factor'}
              </button>
            )}
            {mfaMsg && (
              <div className={`mt-3 text-xs rounded-lg px-3 py-2 ${mfaMsg.ok ? 'text-emerald-400 bg-emerald-500/10 border border-emerald-500/20' : 'text-rose-400 bg-rose-500/10 border border-rose-500/20'}`}>
                {mfaMsg.text}
              </div>
            )}
          </div>

          {/* Upgrade CTA */}
          {acct && !acct.unlimited && acct.plan !== 'pro' && acct.plan !== 'gold' && (
            <div className="glass rounded-2xl p-5 flex items-center justify-between">
              <div>
                <div className="text-slate-100 font-medium">Upgrade to Pro</div>
                <div className="text-xs text-slate-500">1,000 messages + 100 images per day, priority speed.</div>
              </div>
              {billing?.enabled && billing.plans.pro ? (
                <button onClick={() => upgrade('pro')} disabled={checkingOut} className="px-4 py-2 rounded-lg text-white bg-gradient-to-r from-[#c96442] to-[#d8a08a] hover:opacity-90 disabled:opacity-50 transition shadow-glow text-sm font-medium flex items-center gap-2">
                  {checkingOut ? <Loader2 size={15} className="animate-spin" /> : 'Upgrade'}
                </button>
              ) : (
                <Link href="/#pricing" className="px-4 py-2 rounded-lg text-white bg-gradient-to-r from-[#c96442] to-[#d8a08a] hover:opacity-90 transition shadow-glow text-sm font-medium">See plans</Link>
              )}
            </div>
          )}

          {acct && (
            <button onClick={() => { clearAuth(); location.href = '/login' }} className="mt-8 text-xs text-slate-500 hover:text-rose-400">Sign out</button>
          )}
        </>
      )}
    </div>
  )
}
