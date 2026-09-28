'use client'

import { useEffect, useRef, useState } from 'react'
import { Brain, Check, ChevronDown } from 'lucide-react'

/**
 * Reasoning-effort selector (contract §A, rank 7): replaces the tri-state
 * Auto/On/Off Brain toggle. Six positions — auto (omitted → server default),
 * low/medium/high/xhigh (the effort union), off (explicit no-think).
 *
 * Wire mapping at dispatch (page.tsx): auto→undefined, on→true
 * (legacy alias, §A back-compat), low..xhigh pass through, off→false.
 * So a stale client sending `true` still 200s, and a new client can
 * already send 'xhigh' before the tri-state ever existed.
 */
export type EffortValue = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'off'

export const THOUGHT_EFFORTS: Array<{ id: EffortValue; label: string; hint: string }> = [
  { id: 'auto', label: 'Auto', hint: 'Model default' },
  { id: 'low', label: 'Low', hint: 'Quick CoT — easy steps, tight budget' },
  { id: 'medium', label: 'Medium', hint: 'Deep reasoning (≡ legacy on)' },
  { id: 'high', label: 'High', hint: 'Long CoT — hard reasoning, ~2k token cap' },
  { id: 'xhigh', label: 'XHigh', hint: 'Max effort — ~8k token cap, worth it for the hard ones' },
  { id: 'off', label: 'Off', hint: 'Answer directly — no CoT this run' },
]

const ORDER: Record<EffortValue, number> = { auto: 0, low: 1, medium: 2, high: 3, xhigh: 4, off: 5 }

function titleFor(v: EffortValue, m: (typeof THOUGHT_EFFORTS)[number]) {
  return `Reasoning effort: ${m.label} — ${m.hint}`
}

export function EffortSelector({
  value, onChange,
}: {
  value: EffortValue
  onChange: (next: EffortValue) => void
}) {
  /** Pick the non-default state: adds the terracotta ring; off gets the
      struck-through label the old tri-state had. */
  const [open, setOpen] = useState(false)
  const [idx, setIdx] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const meta = THOUGHT_EFFORTS.find((m) => m.id === value) || THOUGHT_EFFORTS[0]

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); return }
      const n = THOUGHT_EFFORTS.length
      if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => (i + 1) % n) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => (i - 1 + n) % n) }
      else if (e.key === 'Home') { e.preventDefault(); setIdx(0) }
      else if (e.key === 'End') { e.preventDefault(); setIdx(n - 1) }
      else if (e.key === 'Enter') { e.preventDefault(); pick(idx) }
      else if (e.key === ' ') { e.preventDefault() }
    }
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, idx])

  const pick = (i: number) => { onChange(THOUGHT_EFFORTS[i].id); setIdx(i); setOpen(false) }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setIdx(ORDER[value]) }}
        // mousedown preventDefault keeps focus on the trigger so the window
        // mousedown (outside-click) sees a fresh open state
        onMouseDown={(e) => { e.preventDefault() }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={value !== 'auto'}
        aria-label={titleFor(value, meta)}
        title={titleFor(value, meta)}
        className={`tap-target h-8 px-2.5 flex items-center gap-1.5 rounded-lg border transition text-xs ${
          value !== 'auto'
            ? 'border-[#c96442]/40 text-[#e79d7f] bg-[#c96442]/[0.07]'
            : 'border-white/[0.08] text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
        }`}
      >
        <Brain size={13} />
        <span className={`hidden md:inline ${value === 'off' ? 'line-through decoration-slate-500' : ''}`}>{meta.label}</span>
        <ChevronDown size={12} className="text-slate-500" />
      </button>
      {open && (
        <div className="absolute bottom-full mb-2 left-0 w-[15.5rem] glass rounded-xl border border-white/[0.08] overflow-hidden z-20 shadow-panel" role="menu" aria-label="Reasoning effort">
          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-widest text-slate-500 font-medium">Reasoning</div>
          {THOUGHT_EFFORTS.map((m, i) => {
            const active = value === m.id
            return (
              <button
                key={m.id}
                type="button"
                role="menuitem"
                aria-selected={active}
                title={titleFor(m.id, m)}
                aria-label={`Reasoning effort: ${m.label}`}
                onClick={() => pick(i)}
                onMouseDown={(e) => { e.preventDefault(); pick(i) }}
                onMouseEnter={() => setIdx(i)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition ${active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.05]'}`}
              >
                <span className="w-4"><Check size={13} className={active ? 'text-[#c96442]' : 'invisible'} /></span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-[13px] ${active ? 'text-slate-100 font-medium' : 'text-slate-200'}`}>{m.label}</span>
                  <span className="block truncate text-[12px] text-slate-500">{m.hint}</span>
                </span>
              </button>
            )
          })}
          {/* xhigh ≠ high is a prompt-level cap, not a transport budget (§A) */}
          <div className="px-3 py-1.5 border-t border-white/[0.05] text-[11px] text-slate-400 truncate">
            {THOUGHT_EFFORTS[idx].hint}
          </div>
        </div>
      )}
    </div>
  )
}
