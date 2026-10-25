'use client'

import Link from 'next/link'
import { Sparkles } from 'lucide-react'
import { motion } from 'framer-motion'
import { modLabel } from '../../lib/platformKey'
import { useI18n } from '../../lib/i18n'

const STARTER_PROMPTS = [
  'Explain quantum computing like I’m 10',
  'Write a Python script to plot a sine wave',
  'Summarise the latest AI research trends',
  'Draft a business plan for a SaaS startup',
] as const

/** First-visit screen: greeting, slash/command hints, starter prompt cards.
 *  Renamed from EmptyState (UI pass): this is the chat welcome hero, not an
 *  empty-library affordance — the shared `EmptyState` primitive in @loop/ui
 *  owns that pattern. */
export function ChatWelcome({ onStartPrompt, headline, note }: {
  onStartPrompt?: (p: string) => void
  /** Bot or group name. Replaces the generic greeting on those threads. */
  headline?: string
  note?: string
}) {
  const { t } = useI18n()
  const title = headline || t('emptyTitle')
  return (
    <div className="flex flex-col items-center justify-start h-full max-w-[48rem] mx-auto text-center px-4 pt-8 sm:pt-14 pb-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        className="space-y-4"
      >
        <div className="w-12 h-12 rounded-2xl surface flex items-center justify-center mx-auto shadow-[0_0_0_1px_var(--accent-soft-border),0_10px_30px_-14px_var(--accent-glow)]">
          <Sparkles size={22} className="text-[var(--accent-text)]" aria-hidden />
        </div>
        <h1 className="text-2xl sm:text-[28px] font-semibold tracking-tight text-[var(--ink-primary)]">
          {title}
        </h1>
        {headline ? (
          <p className="text-[var(--ink-secondary)] text-ui-base max-w-sm mx-auto">
            {note || 'Send a message to start this thread.'}
          </p>
        ) : (
        <p className="text-[var(--ink-secondary)] text-ui-base max-w-sm mx-auto">
          {t('emptyHint').split('{slash}').map((part, i, parts) => (
            i < parts.length - 1
              ? <span key={i}>{part}<span className="font-mono bg-[var(--bg-hover)] px-1.5 py-0.5 rounded text-ui-sm">/</span></span>
              : <span key={i}>{part}</span>
          ))}
          {' '}<span className="font-mono bg-[var(--bg-hover)] px-1.5 py-0.5 rounded text-ui-sm">{modLabel()} K</span> for
          commands. New here? <Link href="/onboarding" className="text-[var(--accent-text)] hover:underline">Take the 2-minute tour →</Link>
        </p>
        )}

        {/* Starter prompt cards stay on a plain new chat. */}
        {!headline && <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mt-8 max-w-lg mx-auto">
          {STARTER_PROMPTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onStartPrompt?.(p)}
              className="text-left px-4 py-3 rounded-2xl bg-[var(--bg-tint)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] transition text-ui-sm text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] leading-relaxed"
            >
              {p}
            </button>
          ))}
        </div>}
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
            className="w-1.5 h-1.5 rounded-full bg-[var(--accent-fill)] animate-bounce"
            style={{ animationDelay: `${d}ms` }}
          />
        ))}
      </span>
      <span className="text-ui-sm text-[var(--ink-muted)] shimmer-text">Thinking…</span>
    </div>
  )
}
