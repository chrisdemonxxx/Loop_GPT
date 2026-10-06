'use client'

import { useEffect, useState } from 'react'
import { ShieldCheck, KeyRound, LogOut, ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { API_URL, authHeaders, clearAuth, apiFetch } from '../../lib/api'
import { SectionHeader, Badge } from '../ui/primitives'

interface Me {
  name?: string; email?: string; role?: string; plan?: string
  credits?: number; imageCredits?: number; unlimited?: boolean; hasDb?: boolean
  usage?: { tokensIn?: number; tokensOut?: number; images?: number; messages?: number }
}

/**
 * Account (blueprint §8): profile summary, plan + credit state, TOTP MFA,
 * and sign-out — all backed by the real /api/account endpoints. Full profile
 * editing (name, photo, password) stays on the standalone /account page,
 * linked from here (contract §1: linked, not duplicated).
 */
export default function AccountTab() {
  const [me, setMe] = useState<Me | null>(null)
  const [mfaEnabled, setMfaEnabled] = useState<boolean | null>(null)
  const [mfaError, setMfaError] = useState('')

  useEffect(() => {
    fetch(`${API_URL}/api/account/me`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { setMe(d); setMfaEnabled(!!d?.totpEnabled) })
      .catch(() => setMe(null))
  }, [])

  const toggleMfa = async (enable: boolean) => {
    setMfaError('')
    try {
      if (enable) {
        const setup = await apiFetch<{ uri: string }>('/api/account/totp/setup', { method: 'POST' })
        if (setup?.uri) window.open('/account#mfa', '_self')
      } else {
        // Disabling needs a live token — the /account page owns the form.
        window.open('/account#mfa', '_self')
      }
    } catch {
      setMfaError('Could not reach the MFA service.')
    }
  }

  const signOut = () => { clearAuth(); window.location.href = '/login' }

  const fmt = (n?: number) => (n === undefined || !Number.isFinite(n) ? '—' : String(n))

  return (
    <div className="space-y-5">
      <SectionHeader title="Profile" />
      <div className="rounded-xl border border-white/[0.06] p-3.5">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#c96442]/30 bg-[#c96442]/[0.1] text-[14px] font-semibold text-[#e79d7f]"
          >
            {(me?.name || me?.email || '?').slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[14px] text-slate-200">{me?.name || 'Not signed in'}</div>
            <div className="truncate text-[12px] text-slate-500">{me?.email || 'Sign in to see your account'}</div>
          </div>
          {me?.role === 'admin' && <Badge tone="accent">admin</Badge>}
        </div>
        <Link href="/account" className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-[#e79d7f] hover:underline">
          Manage your full profile on the account page <ArrowRight size={12} />
        </Link>
      </div>

      <SectionHeader title="Plan & credits" />
      <div className="grid grid-cols-2 gap-2.5">
        <div className="rounded-xl border border-white/[0.06] p-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">Plan</div>
          <div className="mt-1 text-[15px] font-medium capitalize text-slate-200">{me?.plan || '—'}</div>
        </div>
        <div className="rounded-xl border border-white/[0.06] p-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">Credits</div>
          <div className="mt-1 text-[15px] font-medium text-slate-200">
            {me?.unlimited ? 'Unlimited' : fmt(me?.credits)}
          </div>
        </div>
      </div>
      {me?.usage && (
        <div className="rounded-xl border border-white/[0.06] p-3.5 text-[12px] text-slate-400">
          <div className="mb-1.5 text-[11px] uppercase tracking-wider text-slate-500">Lifetime usage</div>
          <div className="grid grid-cols-2 gap-y-1 tabular-nums">
            <span>Messages: {fmt(me.usage.messages)}</span>
            <span>Images: {fmt(me.usage.images)}</span>
            <span>Tokens in: {fmt(me.usage.tokensIn)}</span>
            <span>Tokens out: {fmt(me.usage.tokensOut)}</span>
          </div>
        </div>
      )}

      <SectionHeader title="Security" />
      <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] px-3.5 py-3">
        <span className="flex min-w-0 items-start gap-2.5 text-[13px]">
          {mfaEnabled ? <ShieldCheck size={14} className="mt-0.5 shrink-0 text-emerald-400" /> : <KeyRound size={14} className="mt-0.5 shrink-0 text-slate-500" />}
          <span>
            <span className="block text-slate-300">Two-factor authentication</span>
            <span className="block text-[11px] text-slate-500">
              {mfaEnabled === null ? 'Checking…' : mfaEnabled ? 'TOTP MFA is on' : 'Add a TOTP app as a second factor'}
            </span>
          </span>
        </span>
        <button
          type="button"
          onClick={() => toggleMfa(!mfaEnabled)}
          className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1.5 text-[12px] text-slate-300 transition hover:border-white/25 hover:text-slate-100"
        >
          {mfaEnabled ? 'Manage' : 'Set up'}
        </button>
      </div>
      {mfaError && <p className="text-[12px] text-rose-400">{mfaError}</p>}

      <SectionHeader title="Sign out" />
      <button
        type="button"
        onClick={signOut}
        className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2.5 text-[13px] text-slate-300 transition hover:border-rose-400/40 hover:text-rose-300"
      >
        <LogOut size={14} /> Sign out of this device
      </button>
      <p className="text-[11px] leading-relaxed text-slate-600">
        Signing out clears this browser&apos;s session token. To sign out everywhere, change your password or disable MFA from the account page.
      </p>
    </div>
  )
}