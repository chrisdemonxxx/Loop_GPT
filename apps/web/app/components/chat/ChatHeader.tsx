'use client'

import { useRef, useState } from 'react'
import { PanelLeft, FileDown, Sparkles, FlaskConical, Ghost, Sun, Moon, Monitor, MoreHorizontal, Keyboard } from 'lucide-react'
import { useMenuDismiss } from '../../lib/useMenuDismiss'
import type { ThemeChoice } from '../../lib/theme'

/** The top bar: sidebar toggle, session title, the router's Auto chip,
 * incognito, export menu, Files/Research toggles, and the light/dark/system
 * theme switch (§8-35). Pure presentational; every behavior is delegated
 * through props. (Agent activity is inline per turn — no Activity panel
 * toggle. Model selection lives in the backend fleet router — each turn's
 * choice rides the assistant message's auto chip.) */
export default function ChatHeader({
  sidebarOpen, convTitle,
  incognito, onToggleIncognito,
  hasMessages, onExport,
  artifactCount, artifactsOpen, onToggleArtifacts,
  hasConversation, researchOpen, onToggleResearch,
  onOpenSidebar,
  theme, onCycleTheme,
  onOpenShortcuts,
}: {
  sidebarOpen: boolean
  convTitle?: string
  incognito: boolean
  onToggleIncognito: () => void
  hasMessages: boolean
  onExport: (format: 'md' | 'pdf') => void
  artifactCount: number
  artifactsOpen: boolean
  onToggleArtifacts: () => void
  hasConversation: boolean
  researchOpen: boolean
  onToggleResearch: () => void
  onOpenSidebar: () => void
  /** §8-35: current theme choice (drives the toggle icon + label). */
  theme?: ThemeChoice
  /** §8-35: cycle light → dark → system. */
  onCycleTheme?: () => void
  onOpenShortcuts?: () => void
}) {
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  useMenuDismiss(moreRef, moreOpen, () => setMoreOpen(false))
  const themeLabel = theme === 'light' ? 'Light' : theme === 'dark' ? 'Dark' : 'System'
  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor

  return (
    <div className="flex items-center gap-2 px-3 sm:px-4 h-12 border-b border-white/[0.05] shrink-0 bg-[#08080a]">
      <button
        onClick={onOpenSidebar}
        title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        aria-expanded={sidebarOpen}
        className="p-1.5 rounded-lg hover:bg-white/[0.05] text-slate-400 hover:text-slate-300 transition"
      >
        <PanelLeft size={17} />
      </button>
      {!sidebarOpen && (
        <div className="w-6 h-6 rounded-md bg-[#c96442] flex items-center justify-center shrink-0">
          <Sparkles size={13} className="text-white" />
        </div>
      )}
      <span className="text-[13px] font-medium text-slate-400 truncate min-w-0 flex-1">
        {convTitle || 'New session'}
      </span>
      <div className="flex items-center gap-1 shrink-0">
        <span
          title="The backend fleet router picks the right model for every turn — chat, image, or video"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/[0.07] bg-white/[0.03] text-[12px] text-slate-400 select-none"
        >
          <Sparkles size={11} className="text-[#e79d7f]" aria-hidden /> Auto
        </span>
        <div className="relative" ref={moreRef}>
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            title="More actions"
            className="p-1.5 rounded-lg hover:bg-white/[0.05] text-slate-400 hover:text-slate-300 transition"
          >
            <MoreHorizontal size={16} />
          </button>
          {moreOpen && (
            <div role="menu" className="absolute right-0 top-full mt-1.5 w-52 glass rounded-xl border border-white/[0.08] overflow-hidden z-30 shadow-panel py-1">
              {onCycleTheme && (
                <button role="menuitem" data-testid="theme-toggle" onClick={() => { setMoreOpen(false); onCycleTheme() }} className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-slate-200 hover:bg-white/[0.05]">
                  <ThemeIcon size={14} /> Theme: {themeLabel}
                </button>
              )}
              <button role="menuitem" onClick={() => { setMoreOpen(false); onToggleIncognito() }} className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-slate-200 hover:bg-white/[0.05]">
                <Ghost size={14} /> {incognito ? 'Incognito on' : 'Incognito'}
              </button>
              {hasMessages && (
                <>
                  <button role="menuitem" onClick={() => { setMoreOpen(false); onExport('md') }} className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-slate-200 hover:bg-white/[0.05]"><FileDown size={14} /> Markdown (.md)</button>
                  <button role="menuitem" onClick={() => { setMoreOpen(false); onExport('pdf') }} className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-slate-200 hover:bg-white/[0.05]"><FileDown size={14} /> PDF (print)</button>
                </>
              )}
              {artifactCount > 0 && (
                <button role="menuitem" onClick={() => { setMoreOpen(false); onToggleArtifacts() }} className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-slate-200 hover:bg-white/[0.05]">
                  <FileDown size={14} /> Files ({artifactCount})
                </button>
              )}
              {hasConversation && (
                <button role="menuitem" onClick={() => { setMoreOpen(false); onToggleResearch() }} className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-slate-200 hover:bg-white/[0.05]">
                  <FlaskConical size={14} /> {researchOpen ? 'Hide research' : 'Research'}
                </button>
              )}
              {onOpenShortcuts && (
                <button role="menuitem" onClick={() => { setMoreOpen(false); onOpenShortcuts() }} className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-slate-200 hover:bg-white/[0.05]">
                  <Keyboard size={14} /> Keyboard shortcuts
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
