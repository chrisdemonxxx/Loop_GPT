'use client'

import Link from 'next/link'
import { Sparkles } from 'lucide-react'
import { motion } from 'framer-motion'

const STARTER_PROMPTS = [
  'Explain quantum computing like I’m 10',
  'Write a Python script to plot a sine wave',
  'Summarise the latest AI research trends',
  'Draft a business plan for a SaaS startup',
] as const

/** First-visit screen: greeting, slash/command hints, starter prompt cards. */
export function EmptyState({ onStartPrompt }: { onStartPrompt?: (p: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full max-w-[48rem] mx-auto text-center px-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        className="space-y-4"
      >
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#c96442]/20 to-[#c96442]/8 flex items-center justify-center mx-auto">
          <Sparkles size={22} className="text-gradient" />
        </div>
        <h1 className="text-2xl sm:text-[28px] font-semibold tracking-tight text-gradient">
          How can I help you today?
        </h1>
        <p className="text-slate-400 text-[14px] max-w-sm mx-auto">
          Type <span className="font-mono text-slate-400 bg-white/[0.05] px-1.5 py-0.5 rounded text-[13px]">/</span> for
          deep research. <span className="font-mono text-slate-400 bg-white/[0.05] px-1.5 py-0.5 rounded text-[13px]">⌘K</span> for commands.
          New here? <Link href="/onboarding" className="text-[#e79d7f] hover:underline">Take the 2-minute tour →</Link>
        </p>

        {/* Starter prompt cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mt-6 max-w-md mx-auto">
          {STARTER_PROMPTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onStartPrompt?.(p)}
              className="text-left px-4 py-3 rounded-2xl glass bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] hover:border-white/12 transition text-[13px] text-slate-300 hover:text-slate-100 leading-relaxed"
            >
              {p}
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  )
}

/** Lightweight "Thinking…" pulse shown in the assistant turn before the first
 * token/tool call lands — closes the dead gap between send and activity
 * (audit P5). Under prefers-reduced-motion the CSS pulse is disabled by the
 * global media-query block; the label stays as plain text. */
export function ThinkingDots() {
  return (
    <div className="flex items-center gap-2 py-2" role="status" aria-label="Thinking">
      <span className="flex gap-1" aria-hidden="true">
        {[0, 150, 300].map((d) => (
          <span
            key={d}
            className="w-1.5 h-1.5 rounded-full bg-[#c96442]/70 animate-bounce"
            style={{ animationDelay: `${d}ms` }}
          />
        ))}
      </span>
      <span className="text-[13px] text-slate-400 shimmer-text">Thinking…</span>
    </div>
  )
}
