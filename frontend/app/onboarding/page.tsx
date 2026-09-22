'use client'

import Link from 'next/link'
import { ArrowRight, Blocks, Cable, FlaskConical, FolderKanban, Image as ImageIcon, ListChecks, Mic, Sparkles } from 'lucide-react'

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
    <div className="min-h-screen bg-[#111113] text-slate-200">
      <div className="max-w-3xl mx-auto px-5 py-14">
        <div className="flex items-center gap-2.5 mb-3">
          <div className="w-8 h-8 rounded-lg bg-[#c96442] flex items-center justify-center"><Sparkles size={15} className="text-white" /></div>
          <span className="font-semibold text-slate-100">Loop GPT</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-semibold text-slate-100 mb-3">What to try first</h1>
        <p className="text-slate-500 mb-10 max-w-xl">A two-minute tour of what the agent can do. Every item below is live right now — no setup, no keys.</p>

        <div className="space-y-3">
          {TOUR.map((t, i) => (
            <div key={t.title} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 flex gap-4">
              <div className="w-10 h-10 rounded-xl bg-[#c96442]/10 border border-[#c96442]/20 flex items-center justify-center shrink-0">
                <t.icon size={17} className="text-[#e79d7f]" />
              </div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-[11px] font-mono text-slate-600">{String(i + 1).padStart(2, '0')}</span>
                  <h2 className="text-[15px] font-semibold text-slate-100">{t.title}</h2>
                </div>
                <p className="text-[13.5px] text-slate-400 leading-relaxed mt-1">{t.body}</p>
                <p className="text-[12px] text-slate-600 mt-1.5">{t.tip}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap gap-3">
          <Link href="/chat" className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-white bg-[#c96442] hover:bg-[#b5593a] transition font-medium">
            Start chatting <ArrowRight size={16} />
          </Link>
          <Link href="/" className="inline-flex items-center px-5 py-3 rounded-xl border border-white/10 text-slate-300 hover:bg-white/[0.04] transition">
            Back to home
          </Link>
        </div>
      </div>
    </div>
  )
}
