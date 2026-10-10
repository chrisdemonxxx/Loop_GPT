'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, Ticket } from 'lucide-react'
import { API_URL, authHeaders, hasSession } from '../lib/api'
import { startPlanCheckout } from '../lib/billing'
import { AppPage } from '../components/AppPage'
import { ErrorState, btnOutline, btnSecondary, linkCls, panelCls } from '@loop/ui'

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
  const [busyPlan, setBusyPlan] = useState<string | null>(null)
  const [checkoutError, setCheckoutError] = useState('')

  useEffect(() => {
    fetch(`${API_URL}/api/billing/config`).then((r) => r.json()).then(setConfig).catch(() => setConfig(null))
    fetch(`${API_URL}/api/account/me`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => setMe(null))
  }, [])

  const frozen = config != null && !config.enabled
  const signedIn = Boolean(me) || hasSession()

  const checkout = async (planId: string) => {
    setBusyPlan(planId)
    setCheckoutError('')
    const result = await startPlanCheckout(planId)
    if (result.url) {
      window.location.href = result.url
      return
    }
    setBusyPlan(null)
    setCheckoutError(result.error || 'Could not start checkout.')
  }

  return (
    <AppPage
      documentTitle="Plans"
      title="Plans that grow with you"
      description="Start free. Move up when your daily work needs more headroom. Your plan applies to every surface — web, installed app, and API."
      back={{ href: '/chat', label: 'Chat' }}
      width="wide"
    >
      <div role="radiogroup" aria-label="Plan audience" className="mt-1 inline-flex rounded-xl border border-[var(--border-strong)] p-1">
        <button
          type="button"
          role="radio"
          aria-checked={audience === 'individual'}
          onClick={() => setAudience('individual')}
          className={`rounded-lg px-3.5 py-1.5 text-ui-xs transition ${audience === 'individual' ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]'}`}
        >
          Individual
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={audience === 'team'}
          onClick={() => setAudience('team')}
          className={`rounded-lg px-3.5 py-1.5 text-ui-xs transition ${audience === 'team' ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]'}`}
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
                  className={`rounded-xl border p-5 ${plan.accent ? 'border-[var(--accent-soft-border)] bg-[var(--accent-soft)]' : `${panelCls}`}`}
                >
                  <h2 className="text-ui-md font-medium text-[var(--ink-primary)]">{plan.name}{current && <span className="ml-2 text-2xs text-[var(--success)]">current</span>}</h2>
                  <div className="mt-1.5">
                    <span className="text-2xl font-semibold text-[var(--ink-primary)]">{plan.price}</span>
                    <span className="ml-1 text-ui-xs text-[var(--ink-muted)]">{plan.period}</span>
                  </div>
                  <ul className="mt-3 space-y-1.5">
                    {plan.features.map((f) => (
                      <li key={f} className="flex items-start gap-1.5 text-ui-xs text-[var(--ink-secondary)]">
                        <Check size={12} className="mt-0.5 shrink-0 text-[var(--accent-text)]" aria-hidden /> {f}
                      </li>
                    ))}
                  </ul>
                  {plan.id !== 'free' ? (
                    signedIn ? (
                      <button
                        type="button"
                        disabled={busyPlan === plan.id || current}
                        onClick={() => void checkout(plan.id)}
                        className={`${btnSecondary} mt-4 w-full`}
                      >
                        {current ? 'Current plan' : busyPlan === plan.id ? 'Starting checkout…' : `Upgrade to ${plan.name}`}
                      </button>
                    ) : (
                      <Link href="/signup" className={`${btnSecondary} mt-4 w-full`}>
                        Create an account to upgrade
                      </Link>
                    )
                  ) : (
                    <Link href="/signup" className={`${btnOutline} mt-4 w-full`}>
                      Start free
                    </Link>
                  )}
                </section>
              )
            })}
          </div>

          {frozen && (
            <div role="note" className="mt-5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] p-3.5 text-ui-xs leading-relaxed text-[var(--ink-muted)]">
              Paid checkout is <strong className="text-[var(--ink-secondary)]">not enabled yet</strong>. Signed-in upgrades
              call checkout directly and explain a missing payment link instead of sending you back to sign up.
              Voucher codes already work in Settings → Billing (link below).
            </div>
          )}
          {checkoutError && (
            <div className="mt-3">
              <ErrorState title={checkoutError} compact />
            </div>
          )}

          <div className={`${panelCls} mt-4 p-3.5`}>
            <div className="flex items-center gap-2 text-ui-sm text-[var(--ink-secondary)]"><Ticket size={14} className="text-[var(--ink-muted)]" aria-hidden /> Have a voucher?</div>
            <p className="mt-1 text-ui-xs text-[var(--ink-muted)]">
              Voucher codes work today — redeem them in <Link href="/customize#settings/billing" className={linkCls}>Settings → Billing</Link>.
            </p>
          </div>
        </>
      ) : (
        <div className="mt-5 grid gap-3 max-md:grid-cols-1 md:grid-cols-2">
          <section aria-label="Team plan" className={`${panelCls} p-5`}>
            <h2 className="text-ui-md font-medium text-[var(--ink-primary)]">Team</h2>
            <p className="mt-1.5 text-ui-xs leading-relaxed text-[var(--ink-muted)]">
              Shared connectors, per-member credits, and an admin console. Pricing is per seat with a shared pool.
            </p>
            <Link href="/buying-specialist" className={`mt-3 inline-flex items-center gap-1.5 text-ui-xs ${linkCls}`}>
              Talk to us about Team <ArrowRightish />
            </Link>
          </section>
          <section aria-label="Enterprise plan" className={`${panelCls} p-5`}>
            <h2 className="text-ui-md font-medium text-[var(--ink-primary)]">Enterprise</h2>
            <p className="mt-1.5 text-ui-xs leading-relaxed text-[var(--ink-muted)]">
              SSO, audit logs, custom retention, and deployment support. Volume pricing on request.
            </p>
            <Link href="/buying-specialist" className={`mt-3 inline-flex items-center gap-1.5 text-ui-xs ${linkCls}`}>
              Talk to us about Enterprise <ArrowRightish />
            </Link>
          </section>
        </div>
      )}
    </AppPage>
  )
}

/** Small inline arrow (avoids another icon import for one glyph). */
function ArrowRightish() {
  return <span aria-hidden className="ml-0.5">→</span>
}
