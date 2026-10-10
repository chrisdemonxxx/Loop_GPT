'use client'

import Link from 'next/link'
import { ArrowRight, Blocks, Cable, FlaskConical, FolderKanban, Image as ImageIcon, ListChecks, Mic, Sparkles } from 'lucide-react'
import { AppPage } from '../components/AppPage'
import { btnGhost, btnPrimary, panelCls } from '@loop/ui'

const TOUR = [
  {
    icon: Sparkles,
    title: 'Just ask',
    body: 'Type anything — the agent answers, searches the web, and runs tools on its own. Try: “What time is it in Tokyo?”',
    tip: 'Use the mode picker in the composer: Plan outlines steps first; Ask first confirms before every tool.',
  },
  {
    icon: FlaskConical,
    title: 'Run deep research',
    body: 'Type /research followed by a question. A multi-agent fleet searches dozens of sources, cross-verifies claims, and writes a cited report.',
    tip: 'Research runs survive reloads — reopen the chat to watch them continue.',
  },
  {
    icon: ImageIcon,
    title: 'Create images and documents',
    body: '“Generate an image of a lighthouse at dusk”, or “create a PDF report about renewable energy”. Outputs land in the Files panel with versions.',
    tip: 'Export any conversation from the header — Markdown or PDF.',
  },
  {
    icon: Mic,
    title: 'Talk and listen',
    body: 'Tap the mic in the composer to dictate. Every assistant message has a read-aloud button (copy row → speaker icon).',
    tip: 'Pick a voice and speed in Settings → Personalization → Voice.',
  },
  {
    icon: Blocks,
    title: 'Teach it skills',
    body: 'Say “create a skill that…” in any chat, or build one in Settings → Skills with a live preview of its SKILL.md source.',
    tip: 'Skills activate automatically when their trigger words appear.',
  },
  {
    icon: Cable,
    title: 'Connect your apps',
    body: 'Settings → Connectors: Google Drive/Gmail/Calendar/Sheets, GitHub, Notion, Slack and more — every key is validated on save and testable.',
    tip: 'More apps live in the Marketplace — connect them with your own OAuth app credentials.',
  },
  {
    icon: FolderKanban,
    title: 'Scope work into projects',
    body: 'Create a project, add custom instructions, upload knowledge files, and chats stay grounded in that context with cited retrieval.',
    tip: 'Projects get a first-class section in the sidebar.',
  },
  {
    icon: ListChecks,
    title: 'Stay in control',
    body: 'Settings → Tools sets what the agent may run on its own; the Activity panel shows every tool call with a clickable tool count.',
    tip: 'Type / for the full command palette — every feature is reachable from it.',
  },
]

/** Onboarding — a real "what to try first" guide (brief P2). */
export default function Onboarding() {
  return (
    <AppPage
      documentTitle="What to try first"
      width="default"
      header={(
        <div className="mb-10">
          <h1 className="text-3xl sm:text-4xl font-semibold text-slate-100 mb-3">What to try first</h1>
          <p className="text-[var(--ink-muted)] max-w-xl">A two-minute tour of what the agent can do. Every item below is live right now — no setup, no keys.</p>
        </div>
      )}
    >
      <div className="space-y-3">
        {TOUR.map((t, i) => (
          <div key={t.title} className={`${panelCls} rounded-2xl p-5 flex gap-4`}>
            <div className="w-10 h-10 rounded-xl bg-[var(--accent-soft)] border border-[var(--accent-soft-border)] flex items-center justify-center shrink-0">
              <t.icon size={17} className="text-[var(--accent-text)]" aria-hidden />
            </div>
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-2xs font-mono text-[var(--ink-muted)]">{String(i + 1).padStart(2, '0')}</span>
                <h2 className="text-ui-md font-semibold text-[var(--ink-primary)]">{t.title}</h2>
              </div>
              <p className="text-ui-sm text-[var(--ink-secondary)] leading-relaxed mt-1">{t.body}</p>
              <p className="text-ui-xs text-[var(--ink-muted)] mt-1.5">{t.tip}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link href="/chat" className={`${btnPrimary} px-5 py-3 rounded-xl`}>
          Start chatting <ArrowRight size={16} aria-hidden />
        </Link>
        <Link href="/" className={`${btnGhost} px-5 py-3 rounded-xl`}>
          Back to home
        </Link>
      </div>
    </AppPage>
  )
}
