'use client'

import { useEffect, useState } from 'react'
import { ShieldCheck, KeyRound, LogOut, ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { API_URL, authHeaders, logoutSession, apiFetch } from '../../lib/api'
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

  const signOut = () => { logoutSession(); window.location.href = '/login' }

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

      <SectionHeader title="Your data" />
      <DataControls />

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

/** Export and delete. Both calls tolerate a route the server has not shipped yet. */
function DataControls() {
  const [exportState, setExportState] = useState<'idle' | 'working' | 'error'>('idle')
  const [exportMsg, setExportMsg] = useState('')
  const [confirmDelete, setConfirmDelete] = useState('')
  const [deleteState, setDeleteState] = useState<'idle' | 'working' | 'error'>('idle')
  const [deleteMsg, setDeleteMsg] = useState('')

  const exportData = async () => {
    setExportState('working'); setExportMsg('')
    const res = await fetch(`${API_URL}/api/account/export`, { headers: authHeaders() }).catch(() => null)
    if (!res || res.status === 404 || res.status === 501) {
      setExportState('error'); setExportMsg('Data export is not available yet.')
      return
    }
    if (!res.ok) {
      setExportState('error'); setExportMsg('Could not export your data.')
      return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'loop-gpt-export.json'
    a.click()
    URL.revokeObjectURL(url)
    setExportState('idle')
  }

  const deleteAccount = async () => {
    if (confirmDelete.trim().toLowerCase() !== 'delete') return
    setDeleteState('working'); setDeleteMsg('')
    const res = await fetch(`${API_URL}/api/account`, { method: 'DELETE', headers: authHeaders() }).catch(() => null)
    if (!res || res.status === 404 || res.status === 501) {
      setDeleteState('error'); setDeleteMsg('Account deletion is not available yet.')
      return
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setDeleteState('error'); setDeleteMsg(body.error || 'Could not delete this account.')
      return
    }
    logoutSession()
    window.location.href = '/'
  }

  return (
    <div className="space-y-2.5">
      <div className="rounded-xl border border-white/[0.06] px-3.5 py-3">
        <div className="text-[13px] text-slate-300">Export your data</div>
        <p className="mt-1 text-[11px] text-slate-500">Download a copy of your account, chats, and files.</p>
        <button
          type="button"
          onClick={() => void exportData()}
          disabled={exportState === 'working'}
          className="mt-2 rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-slate-200 hover:border-white/25 disabled:opacity-50"
        >
          {exportState === 'working' ? 'Preparing…' : 'Download export'}
        </button>
        {exportMsg && <p className="mt-2 text-[12px] text-rose-400">{exportMsg}</p>}
      </div>
      <div className="rounded-xl border border-rose-400/20 px-3.5 py-3">
        <div className="text-[13px] text-rose-200">Delete account</div>
        <p className="mt-1 text-[11px] text-slate-500">This removes your account and its chats. Type delete to confirm.</p>
        <div className="mt-2 flex gap-2">
          <input
            aria-label="Type delete to confirm"
            value={confirmDelete}
            onChange={(e) => setConfirmDelete(e.target.value)}
            placeholder="delete"
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-slate-200"
          />
          <button
            type="button"
            onClick={() => void deleteAccount()}
            disabled={deleteState === 'working' || confirmDelete.trim().toLowerCase() !== 'delete'}
            className="rounded-lg border border-rose-400/40 px-3 py-1.5 text-[12px] text-rose-200 hover:bg-rose-500/10 disabled:opacity-50"
          >
            {deleteState === 'working' ? 'Deleting…' : 'Delete account'}
          </button>
        </div>
        {deleteMsg && <p className="mt-2 text-[12px] text-rose-400">{deleteMsg}</p>}
      </div>
    </div>
  )
}