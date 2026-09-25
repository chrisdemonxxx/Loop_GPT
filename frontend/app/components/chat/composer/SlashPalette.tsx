'use client'

import {
  Zap, ChevronDown, ClipboardCheck, Check, ListChecks, Search, MessageSquare,
  Paperclip, Plus, RotateCcw, X, Download as DownloadIcon, Camera, Blocks,
  FolderKanban, Puzzle, Cable, Image as ImageIcon, FilePlus,
} from 'lucide-react'
import type { SlashCommandDef } from '../../../lib/commands'

/** Map a command to a representative icon. */
const ICONS: Record<string, any> = {
  '/chat': MessageSquare, '/agent': Zap, '/research': Search, '/image': ImageIcon,
  '/video': Paperclip, '/create': FilePlus, '/memory': MessageSquare,
  '/new': Plus, '/undo': RotateCcw, '/retry': RotateCcw, '/stop': X, '/export': DownloadIcon,
  '/screenshot': Camera, '/model': ChevronDown, '/settings': Search, '/help': Search,
  '/skills': Blocks, '/projects': FolderKanban, '/connectors': Cable, '/plugins': Puzzle,
}
function iconFor(def: SlashCommandDef) { return ICONS[def.cmd] || MessageSquare }

/** Lightweight slash-command palette above the composer. Highlighting index
 * is owned by the composer (keyboard nav shares it with the textarea). */
export function SlashPalette({
  commands, activeIndex, onHover, onSelect, sections, commandsLabel,
}: {
  commands: SlashCommandDef[]
  activeIndex: number
  onHover: (index: number) => void
  onSelect: (cmd: string) => void
  sections: string[]
  commandsLabel: string
}) {
  if (commands.length === 0) return null
  return (
    <div className="absolute bottom-full mb-2 left-0 right-0 glass rounded-xl border border-white/[0.08] overflow-hidden z-10 shadow-panel max-h-80 overflow-y-auto">
      {sections.map((section) => {
        const items = commands.filter((c) => c.section === section)
        if (!items.length) return null
        return (
          <div key={section}>
            <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-widest text-slate-500 font-medium">{section}</div>
            {items.map((c) => {
              const idx = commands.indexOf(c)
              const Icon = iconFor(c)
              const highlighted = idx === activeIndex
              return (
                <button
                  key={c.cmd}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); onSelect(c.cmd) }}
                  onMouseEnter={() => onHover(idx)}
                  data-slash-index={idx}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition ${
                    highlighted ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'
                  }`}
                >
                  <Icon size={14} className={highlighted ? 'text-[#c96442] shrink-0' : 'text-slate-400 shrink-0'} />
                  <span className="text-[13px] text-slate-200">{c.label}</span>
                  <span className="ml-auto text-[11px] font-mono text-slate-500">{c.cmd}</span>
                </button>
              )
            })}
          </div>
        )
      })}
      {/* Hint line — only for the highlighted command (cuts visual weight). */}
      <div className="px-3 py-1.5 border-t border-white/[0.05] text-[11px] text-slate-400 truncate">
        {commands[activeIndex]?.hint || commandsLabel}
      </div>
    </div>
  )
}

export const RUN_MODES: Array<{ id: 'auto' | 'plan' | 'step' | 'accept'; label: string; hint: string; icon: any }> = [
  { id: 'auto', label: 'Auto', hint: 'Agent decides and uses tools', icon: Zap },
  { id: 'plan', label: 'Plan', hint: 'Outline a plan before acting', icon: ClipboardCheck },
  { id: 'step', label: 'Ask first', hint: 'Confirm before every action', icon: ListChecks },
  { id: 'accept', label: 'Accept edits', hint: 'Run all steps without pausing', icon: Check },
]

/** Run-mode picker: collapsed button with active ring + dropdown menu.
 * `onClose` closes this menu (after a pick); `onCloseOther` closes the +
 * menu when the trigger is clicked (menus are mutually exclusive). */
export function RunModePicker({
  runMode, open, onToggle, onClose, onCloseOther, onChange,
}: {
  runMode: 'auto' | 'plan' | 'step' | 'accept'
  open: boolean
  onToggle: () => void
  onClose: () => void
  onCloseOther: () => void
  onChange: (mode: 'auto' | 'plan' | 'step' | 'accept') => void
}) {
  const activeMode = RUN_MODES.find((m) => m.id === runMode) || RUN_MODES[0]
  const ActiveIcon = activeMode.icon
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => { onToggle(); onCloseOther() }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={activeMode.hint}
        className={`tap-target h-8 px-2.5 flex items-center gap-1.5 rounded-lg border transition ${
          runMode !== 'auto'
            ? 'border-[#c96442]/40 text-[#e79d7f] bg-[#c96442]/[0.07]'
            : 'border-white/[0.08] text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
        } text-xs`}
      >
        <ActiveIcon size={13} />
        {activeMode.label}
        <ChevronDown size={12} className="text-slate-500" />
      </button>
      {open && (
        <div className="absolute bottom-full mb-2 left-0 w-60 glass rounded-xl border border-white/[0.08] overflow-hidden z-20 shadow-panel" role="menu">
          {RUN_MODES.map((m) => (
            <ModeItem key={m.id} icon={m.icon} label={m.label} hint={m.hint} active={runMode === m.id}
              onClick={() => { onChange(m.id); onClose() }} />
          ))}
        </div>
      )}
    </div>
  )
}

function ModeItem({
  icon: Icon, label, hint, active, onClick,
}: {
  icon: any; label: string; hint: string; active?: boolean; onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-white/[0.05] text-left transition"
    >
      <Icon size={15} className={`shrink-0 ${active ? 'text-[#c96442]' : 'text-slate-400'}`} />
      <span className="min-w-0 flex-1">
        <span className={`text-[13px] ${active ? 'text-slate-100 font-medium' : 'text-slate-200'}`}>{label}</span>
        <span className="block text-[12px] text-slate-500">{hint}</span>
      </span>
      {active && <Check size={13} className="text-[#c96442] shrink-0" />}
    </button>
  )
}

export type ToggleState = 'auto' | 'on' | 'off'

const STATE_META: Record<ToggleState, { label: string; cls: string }> = {
  auto: { label: 'Auto', cls: 'border-white/[0.08] text-slate-400' },
  on: { label: 'On', cls: 'border-[#c96442]/40 text-[#e79d7f] bg-[#c96442]/[0.07]' },
  off: { label: 'Off', cls: 'border-white/[0.08] text-slate-500 line-through decoration-slate-500' },
}

/**
 * Tri-state capability toggle (audit §8-25/26): cycles Auto → On → Off.
 * Auto defers to the server/per-chat tool selection default; On and Off are
 * explicit per-run overrides. Used for web search and extended thinking.
 */
export function TriStateToggle({
  icon: Icon, kind, state, onCycle, titleFor,
}: {
  icon: any
  kind: 'web' | 'thinking'
  state: ToggleState
  onCycle: (next: ToggleState) => void
  titleFor: (state: ToggleState) => string
}) {
  const meta = STATE_META[state]
  const next: ToggleState = state === 'auto' ? 'on' : state === 'on' ? 'off' : 'auto'
  const ariaLabel = `${kind === 'web' ? 'Web search' : 'Extended thinking'}: ${meta.label.toLowerCase()}`
  return (
    <button
      type="button"
      onClick={() => onCycle(next)}
      title={titleFor(state)}
      aria-label={ariaLabel}
      aria-pressed={state !== 'auto'}
      className={`tap-target h-8 px-2 flex items-center gap-1 rounded-lg border transition text-xs ${meta.cls}`}
    >
      <Icon size={13} />
      <span className="hidden md:inline">{meta.label}</span>
    </button>
  )
}
