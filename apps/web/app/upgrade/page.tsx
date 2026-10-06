'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Check, Ticket } from 'lucide-react'
import { API_URL, authHeaders } from '../lib/api'

interface Me { plan?: string; unlimited?: boolean; credits?: number }
interface BillingConfig { enabled: boolean; checkoutEnabled: boolean; plans?: Record<string, boolean> }

interface PlanCard { id: string; name: string; price: string; period: string; accent?: boolean; features: readonly string[] }

const PLANS: PlanCard[] = [
  {
    id: 'free', name: 'Free', price: '$0', period: 'forever',
    features: ['Daily credits for chat and images', 'Memory and connectors included', 'Community support'],
  },
  {
    id: 'pro', name: 'Pro', price: '$20', period: 'per month',
    accent: true,
    features: ['More credits every day', 'Video generation', 'Priority access to new models', 'Everything in Free'],
  },
  {
    id: 'gold', name: 'Gold', price: '$100', period: 'per month',
    features: ['The largest credit allowance', 'Highest-priority generation queue', 'Early access features', 'Everything in Pro'],
  },
]

/**
 * Plans (blueprint §9.7 → contract team/CONTRACT_S3_ROUTES.md). The tier
 * structure is real (free/pro/gold are the live plan ids); checkout is FROZEN
 * at the billing service (`enabled:false`, verified RELEASE_P1) — this page
 * shows that truth instead of a fake payment step. Vouchers ARE real
 * (`POST /api/account/redeem`).
 */
export default function UpgradePage() {
  const [audience, setAudience] = useState<'individual' | 'team'>('individual')
  const [me, setMe] = useState<Me | null>(null)
  const [config, setConfig] = useState<BillingConfig | null>(null)

  useEffect(() => {
    document.title = 'Plans - Loop GPT'
    fetch(`${API_URL}/api/billing/config`).then((r) => r.json()).then(setConfig).catch(() => setConfig(null))
    fetch(`${API_URL}/api/account/me`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => setMe(null))
  }, [])

  const frozen = !config?.enabled

  return (
    <main className="min-h-screen bg-[#08080a] px-5 py-8 max-w-4xl mx-auto text-slate-200">
      <Link href="/chat" className="inline-flex items-center gap-1.5 text-[12px] text-slate-400 transition hover:text-slate-200">
        <ArrowLeft size={14} /> Back to chat
      </Link>
      <h1 className="mt-4 text-2xl font-semibold text-slate-100">Plans that grow with you</h1>
      <p className="mt-2 max-w-prose text-[14px] leading-relaxed text-slate-400">
        Start free. Move up when your daily work needs more headroom. Your plan applies to every surface — web, installed app, and API.
      </p>

      <div role="radiogroup" aria-label="Plan audience" className="mt-5 inline-flex rounded-xl border border-white/10 p-1">
        <button
          type="button"
          role="radio"
          aria-checked={audience === 'individual'}
          onClick={() => setAudience('individual')}
          className={`rounded-lg px-3.5 py-1.5 text-[12px] transition ${audience === 'individual' ? 'bg-[#c96442]/[0.12] text-[#e79d7f]' : 'text-slate-400 hover:text-slate-200'}`}
        >
          Individual
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={audience === 'team'}
          onClick={() => setAudience('team')}
          className={`rounded-lg px-3.5 py-1.5 text-[12px] transition ${audience === 'team' ? 'bg-[#c96442]/[0.12] text-[#e79d7f]' : 'text-slate-400 hover:text-slate-200'}`}
        >
          Team and Enterprise
        </button>
      </div>

      {audience === 'individual' ? (
        <>
          <div className="mt-5 grid gap-3 max-md:grid-cols-1 md:grid-cols-3">
            {PLANS.map((plan) => {
              const current = me?.plan === plan.id
              return (
                <section
                  key={plan.id}
                  aria-label={`${plan.name} plan`}
                  className={`rounded-2xl border p-5 ${plan.accent ? 'border-[#c96442]/40 bg-[#c96442]/[0.05]' : 'border-white/[0.07] bg-white/[0.02]'}`}
                >
                  <h2 className="text-[15px] font-medium text-slate-100">{plan.name}{current && <span className="ml-2 text-[11px] text-emerald-400">current</span>}</h2>
                  <div className="mt-1.5">
                    <span className="text-2xl font-semibold text-slate-100">{plan.price}</span>
                    <span className="ml-1 text-[12px] text-slate-500">{plan.period}</span>
                  </div>
                  <ul className="mt-3 space-y-1.5">
                    {plan.features.map((f) => (
                      <li key={f} className="flex items-start gap-1.5 text-[12px] text-slate-400">
                        <Check size={12} className="mt-0.5 shrink-0 text-[#e79d7f]" /> {f}
                      </li>
                    ))}
                  </ul>
                  {plan.id !== 'free' ? (
                    /* Waitlist, not a dead checkout link (P1): billing says
                       "not enabled yet" — sending users there as the CTA was
                       a dead end. Accounts ARE the waitlist until checkout ships. */
                    <Link
                      href="/signup"
                      className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-[#c96442]/40 bg-[#c96442]/[0.08] px-4 py-2 text-[13px] font-medium text-[#e79d7f] transition hover:bg-[#c96442]/[0.14]"
                    >
                      Join the waitlist
                    </Link>
                  ) : (
                    <Link
                      href="/signup"
                      className="mt-4 inline-flex w-full items-center justify-center rounded-xl border border-white/10 px-4 py-2 text-[13px] text-slate-200 transition hover:border-white/25 hover:text-white"
                    >
                      Start free
                    </Link>
                  )}
                </section>
              )
            })}
          </div>

          {frozen && (
            <div role="note" className="mt-5 rounded-xl border border-white/[0.07] p-3.5 text-[12px] leading-relaxed text-slate-500">
              Paid checkout is <strong className="text-slate-300">not enabled yet</strong> — creating an account
              puts you on the waitlist and Pro/Gold unlock for you first when it ships. Voucher codes already
              work in Settings → Billing (link below).
            </div>
          )}

          <div className="mt-4 rounded-xl border border-white/[0.07] p-3.5">
            <div className="flex items-center gap-2 text-[13px] text-slate-300"><Ticket size={14} className="text-slate-500" /> Have a voucher?</div>
            <p className="mt-1 text-[12px] text-slate-500">
              Voucher codes work today — redeem them in <Link href="/customize#settings/billing" className="text-[#e79d7f] hover:underline">Settings → Billing</Link>.
            </p>
          </div>
        </>
      ) : (
        <div className="mt-5 grid gap-3 max-md:grid-cols-1 md:grid-cols-2">
          <section aria-label="Team plan" className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5">
            <h2 className="text-[15px] font-medium text-slate-100">Team</h2>
            <p className="mt-1.5 text-[12px] leading-relaxed text-slate-500">
              Shared connectors, per-member credits, and an admin console. Pricing is per seat with a shared pool.
            </p>
            <Link href="/buying-specialist" className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-[#e79d7f] hover:underline">
              Talk to us about Team <ArrowRightish />
            </Link>
          </section>
          <section aria-label="Enterprise plan" className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5">
            <h2 className="text-[15px] font-medium text-slate-100">Enterprise</h2>
            <p className="mt-1.5 text-[12px] leading-relaxed text-slate-500">
              SSO, audit logs, custom retention, and deployment support. Volume pricing on request.
            </p>
            <Link href="/buying-specialist" className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-[#e79d7f] hover:underline">
              Talk to us about Enterprise <ArrowRightish />
            </Link>
          </section>
        </div>
      )}
    </main>
  )
}

/** Small inline arrow (avoids another icon import for one glyph). */
function ArrowRightish() {
  return <span aria-hidden className="ml-0.5">→</span>
}