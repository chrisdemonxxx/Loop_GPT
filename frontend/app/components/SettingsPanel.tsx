'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { X, Wrench, Puzzle, Blocks, Cable, Brain, Palette, SunMoon } from 'lucide-react'
import MemoryTab from './settings/MemoryTab'
import PersonalizationTab from './settings/PersonalizationTab'
import SkillsTab from './settings/SkillsTab'
import ConnectorsTab from './settings/ConnectorsTab'
import PluginsTab from './settings/PluginsTab'
import ToolsTab from './settings/ToolsTab'
import AppearanceTab from './settings/AppearanceTab'

interface Props { onClose: () => void; initialTab?: string; workspaceId?: string | null; asPage?: boolean }

/**
 * Agent settings — one modal, one visual system. Tab order matches the frontier
 * IA: Skills · Plugins · Memory · Personalization · Appearance · Connectors · Tools.
 * (The legacy "Builder" and "Model/BYOK" tabs are gone: custom HTTP tools now
 * live under Connectors, and model routing is server-side only.)
 */
export default function SettingsPanel({ onClose, initialTab, workspaceId, asPage = false }: Props) {
  const [tab, setTab] = useState(initialTab || 'skills')

  // Escape closes the dialog even when focus is in a field. X and backdrop
  // stay on their own click handlers.
  useEffect(() => {
    if (asPage) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // Nested credential sheet, or an edit that already claimed Escape.
      if (document.querySelector('[data-settings-nested-dialog]')) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, asPage])

  const tabs = [
    { id: 'skills', label: 'Skills', Icon: Blocks },
    { id: 'plugins', label: 'Plugins', Icon: Puzzle },
    { id: 'memory', label: 'Memory', Icon: Brain },
    { id: 'personalization', label: 'Personalization', Icon: Palette },
    { id: 'appearance', label: 'Appearance', Icon: SunMoon },
    { id: 'connectors', label: 'Connectors', Icon: Cable },
    { id: 'tools', label: 'Tools', Icon: Wrench },
  ]

  return (
    <div className={asPage ? "min-h-screen bg-[#08080a] text-slate-200" : "fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[calc(env(safe-area-inset-bottom)+6.5rem)]"} onClick={asPage ? undefined : onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }}
        className={asPage ? "w-full max-w-2xl mx-auto min-h-screen flex flex-col" : "glass-strong rounded-2xl w-full max-w-2xl max-h-[min(86vh,calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom)-7.5rem))] flex flex-col overflow-hidden shadow-panel"}
        onClick={(e) => e.stopPropagation()}
        role={asPage ? "main" : "dialog"} aria-modal={asPage ? undefined : true} aria-label="Agent settings"
      >
        <div className="shrink-0 flex items-center justify-between px-5 py-4 border-b border-white/5">
          <h2 className="text-lg font-semibold text-gradient">Agent settings</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-white/10 rounded-lg text-slate-400" aria-label="Close settings"><X size={18} /></button>
        </div>
        <div className="min-w-0 flex flex-nowrap border-b border-white/5 text-sm overflow-x-auto no-scrollbar" role="tablist">
          {tabs.map(({ id, label, Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`shrink-0 flex items-center gap-1.5 px-4 py-2.5 whitespace-nowrap border-b-2 transition ${
                tab === id ? 'border-[#c96442] text-slate-100' : 'border-transparent text-slate-500 hover:text-slate-200'
              }`}
            >
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          {tab === 'skills' && <SkillsTab />}
          {tab === 'plugins' && <PluginsTab />}
          {tab === 'memory' && <MemoryTab />}
          {tab === 'personalization' && <PersonalizationTab />}
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'connectors' && <ConnectorsTab workspaceId={workspaceId} />}
          {tab === 'tools' && <ToolsTab />}
        </div>
        {/* P5: the last row was landing under the phone's bottom toolbar
            (the sheet sat flush at 844). Same env(safe-area-inset-bottom)
            pattern as the composer footer (page.tsx:615). */}
        <div className="shrink-0 h-[env(safe-area-inset-bottom)]" aria-hidden="true" />
      </motion.div>
    </div>
  )
}
