'use client'

import { useEffect, useState } from 'react'
import { CreditCard, Ticket } from 'lucide-react'
import { API_URL, authHeaders } from '../../lib/api'
import { startPlanCheckout } from '../../lib/billing'
import { SectionHeader, Badge } from '../ui/primitives'

interface BillingConfig {
  enabled: boolean; checkoutEnabled: boolean; plans?: Record<string, boolean>; topUps?: boolean
}
interface Me { plan?: string; credits?: number; imageCredits?: number; unlimited?: boolean; limits?: { credits: number; imageCredits: number } }

/**
 * Billing (blueprint §8): the current plan card + the honest state of the
 * paid surface. Checkout is FROZEN server-side (`/api/billing/config` →
 * enabled:false, verified RELEASE_P1) — this panel shows that truth instead
 * of a fake upgrade flow. Voucher redemption is REAL (POST /api/account/redeem).
 */
export default function BillingTab() {
  const [config, setConfig] = useState<BillingConfig | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  // P0: a slow/failed /me fetch used to render "Credits: —" indistinguishable
  // from "no data" (the Account page showed real numbers at the same time).
  const [meState, setMeState] = useState<'loading' | 'error' | 'ok'>('loading')
  const [code, setCode] = useState('')
  const [redeemState, setRedeemState] = useState<'idle' | 'working' | 'ok' | 'error'>('idle')
  const [redeemMsg, setRedeemMsg] = useState('')
  const [checkoutPlan, setCheckoutPlan] = useState<string | null>(null)
  const [checkoutMsg, setCheckoutMsg] = useState('')

  const loadMe = () => {
    setMeState('loading')
    fetch(`${API_URL}/api/account/me`, { headers: authHeaders() })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then((d) => { setMe(d); setMeState('ok') })
      .catch(() => { setMe(null); setMeState('error') })
  }

  useEffect(() => {
    fetch(`${API_URL}/api/billing/config`).then((r) => r.json()).then(setConfig).catch(() => setConfig(null))
    loadMe()
  }, [])

  const redeem = async () => {
    const trimmed = code.trim()
    if (!trimmed) return
    setRedeemState('working'); setRedeemMsg('')
    const res = await fetch(`${API_URL}/api/account/redeem`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ code: trimmed }),
    }).catch(() => null)
    const body = res ? await res.json().catch(() => ({})) : {}
    if (res?.ok) {
      setRedeemState('ok'); setRedeemMsg(body.message || 'Voucher applied.')
      loadMe()
    } else {
      setRedeemState('error'); setRedeemMsg(body.error || 'Could not redeem that voucher.')
    }
  }

  const creditsLine = (kind: 'credits' | 'imageCredits') => {
    if (meState === 'loading') return '…'
    if (meState === 'error') return '—'
    if (me?.unlimited) return 'Unlimited'
    const value = me?.[kind]
    const limit = me?.limits?.[kind]
    if (value === undefined) return '—'
    return limit !== undefined ? `${value} of ${limit}/day` : String(value)
  }

  return (
    <div className="space-y-5">
      <SectionHeader title="Current plan" />
      <div className="rounded-xl border border-[#c96442]/25 bg-[#c96442]/[0.05] p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2.5">
            <CreditCard size={16} className="text-[#e79d7f]" />
            <span className="text-[15px] font-medium capitalize text-slate-100">{me?.plan || 'Free'} plan</span>
          </span>
          {me?.unlimited && <Badge tone="green">unlimited</Badge>}
        </div>
        <div className="mt-2.5 grid grid-cols-2 gap-y-1 text-[12px] tabular-nums text-slate-400">
          <span>Credits: {creditsLine('credits')}</span>
          <span>Image credits: {creditsLine('imageCredits')}</span>
        </div>
        {meState === 'error' && (
          <div className="mt-2 flex items-center gap-2 text-[12px] text-rose-400">
            Could not load your plan.
            <button type="button" onClick={loadMe} className="text-[#e79d7f] hover:underline">Retry</button>
          </div>
        )}
      </div>

      <SectionHeader title="Upgrade" />
      <div className="rounded-xl border border-white/[0.06] p-3.5">
        {config && !config.enabled && (
          <p className="mb-2 text-[12px] leading-relaxed text-slate-500">
            Paid checkout may still be switched off. If it is, the buttons below say so instead of sending you to sign up again.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {(['pro', 'gold'] as const).map((plan) => (
            <button
              key={plan}
              type="button"
              disabled={checkoutPlan === plan || me?.plan === plan}
              onClick={async () => {
                setCheckoutPlan(plan); setCheckoutMsg('')
                const result = await startPlanCheckout(plan)
                setCheckoutPlan(null)
                if (result.url) { window.location.href = result.url; return }
                setCheckoutMsg(result.error || 'Could not start checkout.')
              }}
              className="rounded-lg border border-[#c96442]/40 bg-[#c96442]/[0.08] px-3.5 py-2 text-[13px] font-medium text-[#e79d7f] transition hover:bg-[#c96442]/[0.14] disabled:opacity-50"
            >
              {me?.plan === plan ? `${plan} is current` : checkoutPlan === plan ? 'Starting…' : `Upgrade to ${plan}`}
            </button>
          ))}
        </div>
        {checkoutMsg && <p role="status" className="mt-2 text-[12px] text-rose-400">{checkoutMsg}</p>}
      </div>

      <SectionHeader title="Vouchers" />
      <div className="rounded-xl border border-white/[0.06] p-3.5">
        <label htmlFor="voucher-code" className="flex items-center gap-2 text-[13px] text-slate-300">
          <Ticket size={14} className="text-slate-500" /> Redeem a voucher code
        </label>
        <div className="mt-2.5 flex gap-2">
          <input
            id="voucher-code"
            type="text"
            value={code}
            onChange={(e) => { setCode(e.target.value); setRedeemState('idle'); setRedeemMsg('') }}
            placeholder="e.g. LOOP-XXXX-XXXX"
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#14141f] px-3 py-2 text-[13px] text-slate-200 placeholder:text-slate-600 focus:border-[#c96442]/50 focus:outline-none"
          />
          <button
            type="button"
            onClick={redeem}
            disabled={redeemState === 'working' || !code.trim()}
            className="shrink-0 rounded-lg border border-[#c96442]/40 bg-[#c96442]/[0.08] px-3.5 py-2 text-[13px] font-medium text-[#e79d7f] transition hover:bg-[#c96442]/[0.14] disabled:opacity-50"
          >
            {redeemState === 'working' ? 'Redeeming…' : 'Redeem'}
          </button>
        </div>
        {redeemMsg && (
          <p role="status" className={`mt-2 text-[12px] ${redeemState === 'ok' ? 'text-emerald-400' : 'text-rose-400'}`}>{redeemMsg}</p>
        )}
      </div>
    </div>
  )
}