'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { X, Wrench, Puzzle, Blocks, Cable, Brain, Palette, SunMoon } from 'lucide-react'
import MemoryTab from './settings/MemoryTab'
import PersonalizationTab from './settings/PersonalizationTab'
import SkillsTab from './settings/SkillsTab'
import ConnectorsTab from './settings/ConnectorsTab'
import PluginsTab from './settings/PluginsTab'
import ToolsTab from './settings/ToolsTab'
import AppearanceTab from './settings/AppearanceTab'

interface Props { onClose: () => void; initialTab?: string; workspaceId?: string | null }

/**
 * Agent settings — one modal, one visual system. Tab order matches the frontier
 * IA: Skills · Plugins · Memory · Personalization · Connectors · Tools.
 * (The legacy "Builder" and "Model/BYOK" tabs are gone: custom HTTP tools now
 * live under Connectors, and model routing is server-side only.)
 */
export default function SettingsPanel({ onClose, initialTab, workspaceId }: Props) {
  const [tab, setTab] = useState(initialTab || 'skills')

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }}
        className="glass-strong rounded-2xl w-full max-w-2xl max-h-[86vh] flex flex-col overflow-hidden shadow-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="Agent settings"
      >
        <div className="shrink-0 flex items-center justify-between px-5 py-4 border-b border-white/5">
          <h2 className="text-lg font-semibold text-gradient">Agent settings</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-white/10 rounded-lg text-slate-400" aria-label="Close settings"><X size={18} /></button>
        </div>
        <div className="shrink-0 flex border-b border-white/5 text-sm overflow-x-auto no-scrollbar" role="tablist">
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
        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'skills' && <SkillsTab />}
          {tab === 'plugins' && <PluginsTab />}
          {tab === 'memory' && <MemoryTab />}
          {tab === 'personalization' && <PersonalizationTab />}
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'connectors' && <ConnectorsTab workspaceId={workspaceId} />}
          {tab === 'tools' && <ToolsTab />}
        </div>
      </motion.div>
    </div>
  )
}
