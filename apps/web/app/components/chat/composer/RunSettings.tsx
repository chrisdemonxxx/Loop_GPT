'use client'

import { useRef, useState } from 'react'
import { Zap, Brain, ChevronDown, Check } from 'lucide-react'
import { THOUGHT_EFFORTS, type EffortValue } from './EffortSelector'
import { RUN_MODES, type ToggleState } from './SlashPalette'
import { FramePopover } from './FramePopover'

/**
 * Run settings — ONE popover for the three run axes (Option A, redesign
 * decision): Autonomy (run mode), Web search, Reasoning effort. Replaces the
 * three look-alike "· Auto" chips (Mode / Web / Reason) plus the dead nested
 * Effort control the model picker used to have.
 *
 * The collapsed chip reads "Auto" when everything is at its default and
 * "Custom" (accented) the moment any axis is overridden.
 */
export function RunSettings({
  runMode,
  webSearch,
  thinking,
  onRunModeChange,
  onWebSearchChange,
  onThinkingChange,
}: {
  runMode: 'auto' | 'plan' | 'step' | 'accept'
  webSearch: ToggleState
  thinking: EffortValue
  onRunModeChange: (mode: 'auto' | 'plan' | 'step' | 'accept') => void
  onWebSearchChange: (next: ToggleState) => void
  onThinkingChange: (next: EffortValue) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const customized = runMode !== 'auto' || webSearch !== 'auto' || thinking !== 'auto'
  const activeMode = RUN_MODES.find((m) => m.id === runMode) || RUN_MODES[0]

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Run settings — Autonomy: ${activeMode.label} · Web: ${webSearch} · Reasoning: ${thinking}`}
        aria-label={`Run settings${customized ? ' (customized)' : ''}`}
        className={`tap-target chip ${customized ? 'chip-on' : ''}`}
      >
        <Zap size={13} />
        <span>{customized ? 'Custom' : 'Auto'}</span>
        <ChevronDown size={12} className="text-slate-500" />
      </button>

      <FramePopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        label="Run settings"
        className="composer-menu w-72 overflow-y-auto bg-[#16161a] rounded-xl border border-white/[0.08] z-50 shadow-panel"
      >
            {/* Autonomy */}
            <div className="px-3 pt-2.5 pb-1 text-[10px] uppercase tracking-widest text-slate-500 font-medium">Autonomy</div>
            {RUN_MODES.map((m) => {
              const active = runMode === m.id
              return (
                <button
                  key={m.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => { onRunModeChange(m.id) }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition ${active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.05]'}`}
                >
                  <m.icon size={15} className={`shrink-0 ${active ? 'text-[var(--accent-text)]' : 'text-slate-400'}`} />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-[13px] ${active ? 'text-slate-100 font-medium' : 'text-slate-200'}`}>{m.label}</span>
                    <span className="block truncate text-[11.5px] text-slate-500">{m.hint}</span>
                  </span>
                  {active && <Check size={13} className="text-[var(--accent-text)] shrink-0" />}
                </button>
              )
            })}

            {/* Web search */}
            <div className="px-3 pt-2.5 pb-1.5 text-[10px] uppercase tracking-widest text-slate-500 font-medium border-t border-white/[0.05] mt-1">Web search</div>
            <div className="px-3 pb-2.5 flex gap-1.5" role="radiogroup" aria-label="Web search">
              {(['auto', 'on', 'off'] as const).map((s) => {
                const active = webSearch === s
                return (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => onWebSearchChange(s)}
                    className={`flex-1 h-8 rounded-lg text-[12px] border transition capitalize ${
                      active
                        ? 'border-[var(--accent-soft-border)] text-[var(--accent-text)] bg-[var(--accent-soft)]'
                        : 'border-white/[0.08] text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
                    }`}
                  >
                    {s}
                  </button>
                )
              })}
            </div>

            {/* Reasoning */}
            <div className="px-3 pt-2.5 pb-1 text-[10px] uppercase tracking-widest text-slate-500 font-medium border-t border-white/[0.05]">Reasoning</div>
            <div className="pb-1.5">
              {THOUGHT_EFFORTS.map((e) => {
                const active = thinking === e.id
                return (
                  <button
                    key={e.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    onClick={() => { onThinkingChange(e.id) }}
                    className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition ${active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.05]'}`}
                  >
                    <Brain size={13} className={`shrink-0 ${active ? 'text-[var(--accent-text)]' : 'text-slate-500'}`} />
                    <span className="min-w-0 flex-1">
                      <span className={`text-[13px] ${active ? 'text-slate-100 font-medium' : 'text-slate-200'}`}>{e.label}</span>
                      <span className="block truncate text-[11.5px] text-slate-500">{e.hint}</span>
                    </span>
                    {active && <Check size={13} className="text-[var(--accent-text)] shrink-0" />}
                  </button>
                )
              })}
            </div>

            <div className="px-3 py-2 border-t border-white/[0.05] text-[11px] text-slate-500">
              Applies to your next message.
            </div>
      </FramePopover>
    </div>
  )
}
