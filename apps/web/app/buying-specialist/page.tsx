'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { ArrowLeft, MessageSquare } from 'lucide-react'

/**
 * Buying specialist (blueprint §9.10 → contract team/CONTRACT_S3_ROUTES.md).
 * No sales-bot backend exists, so this is an honest contact shell — not a
 * fake chat. The mailto carries the buyer's context in the subject.
 */
export default function BuyingSpecialistPage() {
  useEffect(() => { document.title = 'Talk to us - Loop GPT' }, [])

  return (
    <main className="min-h-screen bg-[#08080a] px-5 py-8 max-w-2xl mx-auto text-slate-200">
      <Link href="/upgrade" className="inline-flex items-center gap-1.5 text-[12px] text-slate-400 transition hover:text-slate-200">
        <ArrowLeft size={14} /> Return to plans
      </Link>
      <div className="mt-6 flex items-center gap-3">
        <span aria-hidden className="flex h-10 w-10 items-center justify-center rounded-full border border-[#c96442]/30 bg-[#c96442]/[0.1] text-[#e79d7f]">
          <MessageSquare size={18} />
        </span>
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Talk to our buying specialist</h1>
          <p className="text-[12px] text-slate-500">Team and Enterprise plans, volume pricing, and rollout help.</p>
        </div>
      </div>

      <div className="mt-6 space-y-4">
        <p className="max-w-prose text-[14px] leading-relaxed text-slate-400">
          Tell us what you are building and how many seats you need. A specialist replies with a plan
          recommendation and pricing — usually within one business day.
        </p>

        <ul className="list-inside list-disc space-y-1 text-[13px] text-slate-500">
          <li>Seat count and expected usage (messages, images, videos)</li>
          <li>Which connectors your team depends on</li>
          <li>Any compliance or deployment requirements</li>
        </ul>

        <a
          href="mailto:sales@loop-gpt.cyou?subject=Loop%20GPT%20-%20Team%20or%20Enterprise%20plan"
          className="inline-flex items-center gap-2 rounded-xl border border-[#c96442]/40 bg-[#c96442]/[0.08] px-4 py-2.5 text-[13px] font-medium text-[#e79d7f] transition hover:bg-[#c96442]/[0.14]"
        >
          <MessageSquare size={14} /> Email the buying specialist
        </a>

        <p className="text-[11px] leading-relaxed text-slate-600">
          Prefer self-service? Individual plans are available on the <Link href="/upgrade" className="text-slate-400 underline hover:text-slate-200">plans page</Link>.
        </p>
      </div>
    </main>
  )
}