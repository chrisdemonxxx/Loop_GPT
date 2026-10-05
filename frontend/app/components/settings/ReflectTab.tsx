'use client'

import { Brain, ArrowRight } from 'lucide-react'
import { SectionHeader } from '../ui/primitives'

/**
 * Reflect (blueprint §8): a short-lived summary surface that hands off to
 * Memory. Parity panel — the blueprint's own Reflect is a heading plus a link
 * to memory settings; our memory engine (auto-synthesis, per-item editing)
 * lives in the Memory tab.
 */
export default function ReflectTab({ onOpenMemory }: { onOpenMemory: () => void }) {
  return (
    <div className="space-y-4">
      <SectionHeader title="Reflect" />
      <p className="max-w-prose text-[13px] leading-relaxed text-slate-400">
        Loop GPT reflects on your conversations in the background — pulling durable facts, preferences and
        open threads into memory so the next session starts where the last one ended. Nothing is
        synthesized when memory is off.
      </p>
      <div className="rounded-xl border border-white/[0.06] p-3.5">
        <div className="text-[13px] text-slate-300">What gets remembered</div>
        <ul className="mt-1.5 list-inside list-disc space-y-1 text-[12px] text-slate-500">
          <li>Facts you state about yourself and your work</li>
          <li>Preferences you repeat or ask to be remembered</li>
          <li>Project threads you leave mid-task</li>
        </ul>
      </div>
      <button
        type="button"
        onClick={onOpenMemory}
        className="inline-flex items-center gap-2 rounded-xl border border-[#c96442]/40 bg-[#c96442]/[0.08] px-4 py-2.5 text-[13px] font-medium text-[#e79d7f] transition hover:bg-[#c96442]/[0.14]"
      >
        <Brain size={14} /> Open memory settings <ArrowRight size={13} />
      </button>
    </div>
  )
}