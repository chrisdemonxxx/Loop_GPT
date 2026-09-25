'use client'

import { useState } from 'react'
import { PanelLeft, FileDown, Cpu, Sparkles, FlaskConical, Ghost } from 'lucide-react'
import ModelSelector from '../ModelSelector'

/** The top bar: sidebar toggle, session title, model selector, incognito,
 * export menu, Files/Research/Activity toggles. Pure presentational; every
 * behavior is delegated through props. */
export default function ChatHeader({
  sidebarOpen, convTitle, modelTier, onModelChange,
  incognito, onToggleIncognito,
  hasMessages, onExport,
  artifactCount, artifactsOpen, onToggleArtifacts,
  hasConversation, researchOpen, onToggleResearch,
  computerOpen, onToggleComputer,
  onOpenSidebar,
}: {
  sidebarOpen: boolean
  convTitle?: string
  modelTier: string
  onModelChange: (id: string) => void
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
  computerOpen: boolean
  onToggleComputer: () => void
  onOpenSidebar: () => void
}) {
  const [exportMenuOpen, setExportMenuOpen] = useState(false)

  return (
    <div className="flex items-center gap-2 px-3 sm:px-4 h-12 border-b border-white/[0.05] shrink-0 bg-[#111113]">
      {!sidebarOpen && (
        <button
          onClick={onOpenSidebar}
          className="p-1.5 rounded-lg hover:bg-white/[0.05] text-slate-500 hover:text-slate-300 transition"
        >
          <PanelLeft size={17} />
        </button>
      )}
      {!sidebarOpen && (
        <div className="w-6 h-6 rounded-md bg-[#c96442] flex items-center justify-center shrink-0">
          <Sparkles size={13} className="text-white" />
        </div>
      )}
      <span className="text-[13px] font-medium text-slate-400 truncate">
        {convTitle || 'New session'}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <ModelSelector value={modelTier} onChange={onModelChange} />
        <button
          onClick={onToggleIncognito}
          title={incognito ? 'Incognito on — new chats are private and use no memory. Click to turn off.' : 'Incognito — private chat, no memory, hidden from history'}
          aria-pressed={incognito}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] border transition ${
            incognito
              ? 'border-[#c96442]/40 text-[#e79d7f] bg-[#c96442]/[0.07]'
              : 'border-white/[0.06] text-slate-500 hover:bg-white/[0.05] hover:text-slate-300'
          }`}
        >
          <Ghost size={13} />
          <span className="hidden sm:inline">{incognito ? 'Incognito' : ''}</span>
        </button>
        {hasMessages && (
          <div className="relative">
            <button
              onClick={() => setExportMenuOpen((v) => !v)}
              title="Export conversation"
              aria-label="Export conversation"
              aria-haspopup="menu"
              aria-expanded={exportMenuOpen}
              className="p-1.5 rounded-lg hover:bg-white/[0.05] text-slate-500 hover:text-slate-300 transition"
            >
              <FileDown size={15} />
            </button>
            {exportMenuOpen && (
              <div role="menu" className="absolute right-0 top-full mt-1.5 w-40 glass rounded-xl border border-white/[0.08] overflow-hidden z-30 shadow-panel">
                <button role="menuitem" onClick={() => { setExportMenuOpen(false); onExport('md') }} className="w-full text-left px-3 py-2 text-[13px] text-slate-200 hover:bg-white/[0.05] transition">Markdown (.md)</button>
                <button role="menuitem" onClick={() => { setExportMenuOpen(false); onExport('pdf') }} className="w-full text-left px-3 py-2 text-[13px] text-slate-200 hover:bg-white/[0.05] transition">PDF (print)</button>
              </div>
            )}
          </div>
        )}
        {artifactCount > 0 && (
          <button
            onClick={onToggleArtifacts}
            title="Toggle artifacts panel"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] border transition ${
              artifactsOpen
                ? 'border-white/15 text-slate-200 bg-white/[0.08]'
                : 'border-white/[0.06] text-slate-500 hover:bg-white/[0.05] hover:text-slate-300'
            }`}
          >
            <FileDown size={13} />
            <span className="hidden sm:inline">Files</span>
            <span className="text-slate-600">{artifactCount}</span>
          </button>
        )}
        {hasConversation && (
          <button
            onClick={onToggleResearch}
            title="Research runs"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] border transition ${
              researchOpen
                ? 'border-white/15 text-slate-200 bg-white/[0.08]'
                : 'border-white/[0.06] text-slate-500 hover:bg-white/[0.05] hover:text-slate-300'
            }`}
          >
            <FlaskConical size={13} />
            <span className="hidden sm:inline">Research</span>
          </button>
        )}
        <button
          onClick={onToggleComputer}
          title="Toggle Activity panel"
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] border transition ${
            computerOpen
              ? 'border-white/15 text-slate-200 bg-white/[0.08]'
              : 'border-white/[0.06] text-slate-500 hover:bg-white/[0.05] hover:text-slate-300'
          }`}
        >
          <Cpu size={13} />
          <span className="hidden sm:inline">Activity</span>
        </button>
      </div>
    </div>
  )
}
