'use client'

import { useEffect, useRef, useState } from 'react'
import { Sparkles, ChevronDown, Check, Eye, Wrench, Brain, Zap, Plus } from 'lucide-react'
import { API_URL } from '../lib/api'

interface ModelSpec {
  id: string
  tier: string
  label: string
  description: string
  contextTokens: number
}

interface Props {
  value: string
  onChange: (id: string) => void
}

/** Same six as EffortSelector.tsx (rank 7) — the picker nests them under each
 * row (Claude nests Effort under the model menu; ours was the peer chip). */
type EffortValue = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'off'
const EFFORTS: Array<{ id: EffortValue; label: string }> = [
  { id: 'auto', label: 'Auto' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'XHigh' },
  { id: 'off', label: 'Off' },
]

function fmtContext(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

/** Hosted-model picker. Reads the public catalog and lists each tier with
 * capability badges; '' means "let the router decide". A6 row (GAP-029):
 * nested `Effort ▸` per row (six positions) + "More models" footer
 * (row-3 slot, pending the P6 catalog depth). */
export default function ModelSelector({ value, onChange }: Props) {
  const [models, setModels] = useState<ModelSpec[]>([])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [effort, setEffort] = useState<Record<string, EffortValue>>({})
  const [effortFor, setEffortFor] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch(`${API_URL}/api/models/catalog`)
      .then((r) => r.json())
      .then((d) => setModels(d.models || []))
      .catch(() => setError('Failed to load catalog'))
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDoc)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDoc)
    }
  }, [open])

  const selected = models.find((m) => m.id === value) || models[0]
  const label = selected ? selected.label : 'Model'

  const toggle = (id: string) => {
    // picker is host-only — hidden ids (row 3) aren't in the public catalog
    if (!models.some((m) => m.id === id)) return
    onChange(id)
    setOpen(false)
  }

  const pickEffort = (id: string, e: EffortValue) => {
    setEffort((cur) => ({ ...cur, [id]: e }))
    setEffortFor(null)
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={!!error}
        aria-label={`Choose model${selected ? `: ${selected.label}` : ''}`}
        title={error ?? 'Choose model'}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] border text-slate-400 hover:bg-white/[0.05] hover:text-slate-200 hover:border-white/[0.12] transition ${error ? 'border-red-400/40 text-red-300' : 'border-white/[0.06]'}`}
      >
        <Sparkles size={13} />
        <span className="hidden sm:inline">{label}</span>
        <ChevronDown size={12} className="text-slate-600" />
      </button>
      {open && (
        <div role="listbox" aria-label="Model" className="absolute top-full right-0 mt-2 w-72 glass-strong rounded-xl border border-white/[0.08] overflow-hidden z-30 shadow-panel">
          {models.map((m) => {
            const eff = effort[m.id] ?? 'auto'
            const effOpen = effortFor === m.id
            return (
              <button
                key={m.id}
                role="option"
                aria-selected={value === m.id}
                onClick={() => toggle(m.id)}
                className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-white/[0.05] transition border-t border-white/[0.04]"
              >
                <Brain size={15} className={`mt-0.5 shrink-0 ${value === m.id ? 'text-[#c96442]' : 'text-slate-500'}`} />
                <span className="min-w-0 flex-1">
                  <span className="text-[13px] text-slate-200">{m.label}</span>
                  <span className="block text-[12px] text-slate-500">{m.description}</span>
                  <span className="mt-1 flex flex-wrap gap-1.5">
                    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-white/[0.05] text-slate-400">
                      <Brain size={9} /> {fmtContext(m.contextTokens)} ctx
                    </span>
                    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-white/[0.05] text-slate-400">
                      <Wrench size={9} /> tools
                    </span>
                    {m.tier === 'vision' && (
                      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-white/[0.05] text-slate-400">
                        <Eye size={9} /> vision
                      </span>
                    )}
                  </span>
                  <span className="mt-1.5 inline-flex">
                    <button
                      type="button"
                      aria-haspopup="menu"
                      aria-expanded={effOpen}
                      aria-label={`Effort: ${eff === 'auto' ? 'Auto' : eff}`}
                      title={`Effort: ${eff === 'auto' ? 'Auto' : eff}`}
                      onClick={(e) => { e.stopPropagation(); setEffortFor(effOpen ? null : m.id) }}
                      className="tap-target inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] border border-white/[0.08] text-slate-400 hover:text-slate-200 hover:border-white/[0.16] transition"
                    >
                      <Zap size={10} /> Effort: {eff === 'auto' ? 'Auto' : eff}
                    </button>
                    {effOpen && (
                      <span className="absolute left-10 top-full mt-1 w-[11rem] glass rounded-lg border border-white/[0.08] overflow-hidden z-40 shadow-panel" role="menu" aria-label="Effort">
                        {EFFORTS.map((o) => {
                          const on = eff === o.id
                          return (
                            <button
                              key={o.id}
                              type="button"
                              role="menuitem"
                              aria-checked={on}
                              title={`Effort: ${o.label}`}
                              onClick={(e) => { e.stopPropagation(); pickEffort(m.id, o.id) }}
                              className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition ${on ? 'bg-white/[0.07] text-slate-100' : 'text-slate-400 hover:bg-white/[0.05]'}`}
                            >
                              <span className="w-3.5">{on && <Check size={11} className="text-[#c96442]" />}</span>
                              {o.label}
                            </button>
                          )
                        })}
                      </span>
                    )}
                  </span>
                </span>
                {value === m.id && <Check size={13} className="text-[#c96442] mt-0.5 shrink-0" />}
              </button>
            )
          })}
          <button
            type="button"
            onClick={() => {}}
            title="More models (row 3 — pending P6)"
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12px] text-slate-500 hover:text-slate-300 hover:bg-white/[0.04] border-t border-white/[0.08] transition"
          >
            <Plus size={13} /> More models
          </button>
        </div>
      )}
    </div>
  )
}
