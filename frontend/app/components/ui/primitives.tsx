'use client'

/**
 * Shared design primitives for the settings family (Skills / Plugins / Memory /
 * Personalization / Connectors / Tools) and the app chrome. One visual system:
 * one accent (#c96442), neutral surfaces, consistent radii, 8px grid.
 */
import type { ReactNode } from 'react'

export const inputCls =
  'w-full bg-ink-800 border border-white/10 rounded-lg px-3 py-2 text-slate-100 text-sm focus:outline-none focus:accent-ring placeholder-slate-600 transition'
export const btnPrimary =
  'inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium text-white bg-[#c96442] hover:bg-[#b5593a] active:bg-[#a34e34] disabled:opacity-40 disabled:cursor-not-allowed transition'
export const btnGhost =
  'inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm text-slate-300 hover:bg-white/5 transition'
export const cardCls =
  'rounded-xl border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.035] hover:border-white/[0.1] transition'

/** A settings card row: title + description on the left, actions on the right. */
export function Card({
  title, description, badge, active, onClick, actions, children, className = '',
}: {
  title: ReactNode
  description?: ReactNode
  badge?: ReactNode
  active?: boolean
  onClick?: () => void
  actions?: ReactNode
  children?: ReactNode
  className?: string
}) {
  const clickable = !!onClick
  return (
    <div
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick() } : undefined}
      className={`p-3.5 flex items-start justify-between gap-3 ${cardCls} ${active ? 'border-[#c96442]/40 bg-[#c96442]/[0.06]' : ''} ${clickable ? 'cursor-pointer' : ''} ${className}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-100 truncate">{title}</span>
          {badge}
          {active && <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#c96442]/15 text-[#e79d7f] shrink-0">active</span>}
        </div>
        {description && <div className="text-xs text-slate-500 mt-0.5 line-clamp-2">{description}</div>}
        {children}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  )
}

/** Accessible on/off toggle matching the single-accent system. */
export function Toggle({ on, onChange, label }: { on: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`shrink-0 w-11 h-6 rounded-full transition ${on ? 'bg-[#c96442]' : 'bg-white/10 hover:bg-white/15'}`}
    >
      <span className={`block w-5 h-5 bg-white rounded-full transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  )
}

/** Section header with a subtle divider + optional count. */
export function SectionHeader({ title, count, action }: { title: string; count?: number | null; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between pt-1">
      <div className="text-[11px] uppercase tracking-widest text-slate-500 font-medium">
        {title}{typeof count === 'number' && <span className="ml-1.5 text-slate-600">{count}</span>}
      </div>
      {action}
    </div>
  )
}

/** Live status dot (idle / working / error). */
export function StatusDot({ state }: { state: 'idle' | 'working' | 'waiting' | 'error' | 'ok' }) {
  const map: Record<string, string> = {
    idle: 'bg-slate-600',
    working: 'bg-neon-green animate-pulseGlow',
    waiting: 'bg-amber-400 animate-pulseGlow',
    error: 'bg-rose-400',
    ok: 'bg-neon-green',
  }
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${map[state]}`} aria-hidden />
}

/** Search input with result count / clear. */
export function SearchInput({
  value, onChange, placeholder, resultCount,
}: { value: string; onChange: (v: string) => void; placeholder: string; resultCount?: number | null }) {
  return (
    <div className="relative">
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className={inputCls + ' pl-8'}
      />
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" aria-hidden>
        <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
      </svg>
      {value && (
        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-slate-600">
          {typeof resultCount === 'number' ? `${resultCount} result${resultCount === 1 ? '' : 's'}` : ''}
        </span>
      )}
    </div>
  )
}

/** Proper empty state: illustration block, heading, copy, optional action. */
export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="py-8 flex flex-col items-center text-center gap-2.5">
      {icon && (
        <div className="w-12 h-12 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center text-slate-500">
          {icon}
        </div>
      )}
      <div className="text-sm font-medium text-slate-300">{title}</div>
      {body && <div className="text-xs text-slate-500 max-w-[320px] leading-relaxed">{body}</div>}
      {action && <div className="pt-1">{action}</div>}
    </div>
  )
}

/** Badge chip (built-in / custom / status). */
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'green' | 'amber' | 'rose' }) {
  const tones: Record<string, string> = {
    neutral: 'bg-white/[0.05] text-slate-400',
    accent: 'bg-[#c96442]/15 text-[#e79d7f]',
    green: 'bg-emerald-500/10 text-emerald-400',
    amber: 'bg-amber-500/10 text-amber-400/90',
    rose: 'bg-rose-500/10 text-rose-400',
  }
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${tones[tone]} shrink-0`}>{children}</span>
}
