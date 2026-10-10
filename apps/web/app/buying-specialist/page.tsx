'use client'

import Link from 'next/link'
import { MessageSquare } from 'lucide-react'
import { AppPage } from '../components/AppPage'
import { btnSecondary, linkCls } from '@loop/ui'

/**
 * Buying specialist (blueprint §9.10 → contract team/CONTRACT_S3_ROUTES.md).
 * No sales-bot backend exists, so this is an honest contact shell — not a
 * fake chat. The mailto carries the buyer's context in the subject.
 */
export default function BuyingSpecialistPage() {
  return (
    <AppPage
      documentTitle="Talk to us"
      title="Talk to our buying specialist"
      description="Team and Enterprise plans, volume pricing, and rollout help."
      back={{ href: '/upgrade', label: 'Plans' }}
      icon={(
        <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--accent-soft-border)] bg-[var(--accent-soft)] text-[var(--accent-text)]">
          <MessageSquare size={18} />
        </span>
      )}
    >
      <div className="space-y-4">
        <p className="max-w-prose text-ui-base leading-relaxed text-[var(--ink-secondary)]">
          Tell us what you are building and how many seats you need. A specialist replies with a plan
          recommendation and pricing — usually within one business day.
        </p>

        <ul className="list-inside list-disc space-y-1 text-ui-sm text-[var(--ink-muted)]">
          <li>Seat count and expected usage (messages, images, videos)</li>
          <li>Which connectors your team depends on</li>
          <li>Any compliance or deployment requirements</li>
        </ul>

        <a href="mailto:sales@loop-gpt.cyou?subject=Loop%20GPT%20-%20Team%20or%20Enterprise%20plan" className={btnSecondary}>
          <MessageSquare size={14} aria-hidden /> Email the buying specialist
        </a>

        <p className="text-2xs leading-relaxed text-[var(--ink-muted)]">
          Prefer self-service? Individual plans are available on the <Link href="/upgrade" className={`${linkCls} underline`}>plans page</Link>.
        </p>
      </div>
    </AppPage>
  )
}
