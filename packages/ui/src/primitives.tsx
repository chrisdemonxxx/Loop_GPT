'use client'

import type { ReactNode } from 'react'

/**
 * Shared design primitives for every section of the app (chat chrome, the
 * settings family, Build, standalone pages). One visual system: one accent,
 * neutral surfaces, consistent radii, 8px grid.
 *
 * Colors come from the CSS-variable tokens in apps/web/app/globals.css
 * (`--accent-*`, `--bg-*`, `--ink-*`, `--border-*`, `--danger-*`), which
 * carry their own light-theme values — no per-class light remap needed.
 *
 * Tailwind note: class names live here; the consuming app's Tailwind content
 * globs must include this package's sources (see apps/web/tailwind.config.js).
 */
const fieldBase =
  'bg-[var(--bg-raised)] border border-[var(--border-strong)] rounded-lg px-3 py-2 text-[var(--ink-primary)] text-sm focus:outline-none focus:accent-ring placeholder:text-[var(--ink-muted)] disabled:opacity-50 transition'
export const inputCls = `w-full ${fieldBase}`
/** Native <select>: sized to its content unless the caller adds w-full. */
export const selectCls = fieldBase
export const textareaCls = `w-full ${fieldBase} resize-y leading-relaxed`

const btnBase =
  'inline-flex items-center justify-center gap-1.5 rounded-lg text-sm transition disabled:opacity-40 disabled:cursor-not-allowed'
/** Solid accent CTA (white on --accent-fill passes AA in both themes). */
export const btnPrimary =
  `${btnBase} px-3.5 py-2 font-medium text-white bg-[var(--accent-fill)] hover:bg-[var(--accent-fill-hover)] active:bg-[var(--accent-fill-active)]`
/** Tinted accent outline: the secondary call to action. */
export const btnSecondary =
  `${btnBase} px-3.5 py-2 font-medium text-[var(--accent-text)] border border-[var(--accent-soft-border)] bg-[var(--accent-soft)] hover:bg-[var(--accent-soft-hover)]`
/** Quiet action: cancel, retry, toolbar buttons. */
export const btnGhost =
  `${btnBase} px-3 py-2 text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)]`
/** Neutral outline: equal-weight action next to a primary. */
export const btnOutline =
  `${btnBase} px-3 py-2 text-[var(--ink-primary)] border border-[var(--border-strong)] hover:bg-[var(--bg-hover)]`
/** Destructive confirm (white on --danger-strong passes AA in both themes). */
export const btnDanger =
  `${btnBase} px-3.5 py-2 font-medium text-white bg-[var(--danger-strong)] hover:bg-[var(--danger-strong-hover)]`
/** Destructive but not final (opens a confirm): danger-tinted outline. */
export const btnDangerOutline =
  `${btnBase} px-3 py-2 text-[var(--danger)] border border-[var(--danger-soft-border)] hover:bg-[var(--danger-soft)]`
/** Text link in accent, underlined for link-in-text contrast. */
export const linkCls = 'text-[var(--accent-text)] underline-offset-2 hover:underline'
export const cardCls =
  'rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] hover:bg-[var(--bg-hover)] hover:border-[var(--border-strong)] transition'
/** Static panel: same surface as cardCls without hover affordance. */
export const panelCls = 'rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)]'

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
      className={`p-3.5 flex items-start justify-between gap-3 ${cardCls} ${active ? 'border-[var(--accent-soft-border)] bg-[var(--accent-soft)]' : ''} ${clickable ? 'cursor-pointer' : ''} ${className} max-sm:flex-col`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--ink-primary)] truncate">{title}</span>
          {badge}
          {active && <span className="text-3xs px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent-text)] shrink-0">active</span>}
        </div>
        {description && <div className="text-xs text-[var(--ink-muted)] mt-0.5 line-clamp-2">{description}</div>}
        {children}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  )
}

/** Label + value tile (balances, usage counters, plan summary). */
export function StatCard({ label, value, sub, icon }: { label: ReactNode; value: ReactNode; sub?: ReactNode; icon?: ReactNode }) {
  return (
    <div className={`${panelCls} p-3.5 flex flex-col gap-1`}>
      <div className="flex items-center gap-1.5 text-2xs text-[var(--ink-muted)]">{icon}{label}</div>
      <div className="text-lg font-semibold text-[var(--ink-primary)]">{value}</div>
      {sub && <div className="text-2xs text-[var(--ink-muted)]">{sub}</div>}
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
      className={`shrink-0 w-11 h-6 rounded-full transition ${on ? 'bg-[var(--accent-fill)]' : 'bg-[var(--border-strong)] hover:bg-[var(--bg-hover-strong)]'}`}
    >
      <span className={`block w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  )
}

/** Section header with a subtle divider + optional count. */
export function SectionHeader({ title, count, action }: { title: string; count?: number | null; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between pt-1">
      <div className="text-2xs uppercase tracking-widest text-[var(--ink-muted)] font-medium">
        {title}{typeof count === 'number' && <span className="ml-1.5 opacity-80">{count}</span>}
      </div>
      {action}
    </div>
  )
}

/** Live status dot (idle / working / error). */
export function StatusDot({ state }: { state: 'idle' | 'working' | 'waiting' | 'error' | 'ok' }) {
  const map: Record<string, string> = {
    idle: 'bg-[var(--ink-muted)]',
    working: 'bg-[var(--success)] animate-pulseGlow',
    waiting: 'bg-[var(--warning)] animate-pulseGlow',
    error: 'bg-[var(--danger)]',
    ok: 'bg-[var(--success)]',
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
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--ink-muted)] pointer-events-none" aria-hidden>
        <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
      </svg>
      {value && (
        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-2xs text-[var(--ink-muted)]">
          {typeof resultCount === 'number' ? `${resultCount} result${resultCount === 1 ? '' : 's'}` : ''}
        </span>
      )}
    </div>
  )
}

/** Loading skeleton: the pulse stands in for content that is on its way.
 *  `lines` renders stacked bars; `card` renders one directory-card shape. */
export function Skeleton({ variant = 'lines', count = 2 }: { variant?: 'lines' | 'card'; count?: number }) {
  if (variant === 'card') {
    return (
      <div aria-hidden className="animate-pulse rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] p-3.5">
        <div className="flex items-start gap-2.5">
          <div className="h-8 w-8 shrink-0 rounded-lg bg-[var(--bg-hover-strong)]" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3 w-1/3 rounded bg-[var(--bg-hover-strong)]" />
            <div className="h-2.5 w-full rounded bg-[var(--bg-hover)]" />
            <div className="h-2.5 w-2/3 rounded bg-[var(--bg-hover)]" />
          </div>
        </div>
        <div className="mt-3 h-2.5 w-16 rounded bg-[var(--bg-hover)]" />
      </div>
    )
  }
  return (
    <div aria-hidden className="animate-pulse space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="h-2.5 rounded bg-[var(--bg-hover)]" style={{ width: i === count - 1 ? '60%' : '100%' }} />
      ))}
    </div>
  )
}

/**
 * The one loading state. `card`/`lines` render skeletons; `inline` renders a
 * spinner + label for small regions (a tab body, a list footer). Always a
 * labelled live region so screen readers hear what is loading.
 */
export function LoadingState({
  label, variant = 'inline', count = 1, className = '',
}: { label: string; variant?: 'inline' | 'card' | 'lines'; count?: number; className?: string }) {
  if (variant === 'inline') {
    return (
      <div role="status" aria-label={label} className={`flex items-center gap-2 py-3 text-ui-xs text-[var(--ink-muted)] ${className}`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5 animate-spin" aria-hidden>
          <path d="M21 12a9 9 0 1 1-6.2-8.56" strokeLinecap="round" />
        </svg>
        <span>{label}</span>
      </div>
    )
  }
  return (
    <div role="status" aria-label={label} className={`space-y-2 ${className}`}>
      {variant === 'card'
        ? Array.from({ length: count }).map((_, i) => <Skeleton key={i} variant="card" />)
        : <Skeleton variant="lines" count={Math.max(2, count)} />}
    </div>
  )
}

/**
 * The one error state: title, message, optional next-step hint, and actions
 * (Retry renders when `onRetry` is passed). `danger` is the default tone for
 * failures; `neutral` suits "service not deployed yet" style notices.
 * `compact` drops the panel chrome for tight spots (sidebar lists, a row).
 */
export function ErrorState({
  title, message, hint, onRetry, retryLabel = 'Retry', actions, onDismiss, tone = 'danger', compact = false, className = '',
}: {
  title: ReactNode
  message?: ReactNode
  hint?: ReactNode
  onRetry?: () => void
  retryLabel?: string
  actions?: ReactNode
  onDismiss?: () => void
  tone?: 'danger' | 'neutral'
  compact?: boolean
  className?: string
}) {
  const panel = tone === 'danger'
    ? 'border-[var(--danger-soft-border)] bg-[var(--danger-soft)]'
    : 'border-[var(--border-strong)] bg-[var(--bg-panel)]'
  const titleColor = tone === 'danger' ? 'text-[var(--danger)]' : 'text-[var(--ink-primary)]'
  if (compact) {
    return (
      <div role="alert" className={`py-3 text-center ${className}`}>
        <p className={`text-ui-xs ${titleColor}`}>{title}</p>
        {message && <p className="mt-0.5 text-2xs text-[var(--ink-muted)]">{message}</p>}
        {onRetry && <button type="button" onClick={onRetry} className={`mt-1.5 text-ui-xs ${linkCls} underline`}>{retryLabel}</button>}
      </div>
    )
  }
  return (
    <div role="alert" className={`rounded-xl border ${panel} px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between ${className}`}>
      <div className="min-w-0">
        <p className={`text-ui-sm font-medium ${titleColor}`}>{title}</p>
        {message && <p className="mt-0.5 text-ui-sm text-[var(--ink-secondary)]">{message}</p>}
        {hint && <p className="mt-1 text-ui-xs text-[var(--ink-muted)]">{hint}</p>}
      </div>
      {(actions || onRetry || onDismiss) && (
        <div className="flex items-center gap-2 shrink-0">
          {actions}
          {onRetry && <button type="button" className={btnGhost} onClick={onRetry}>{retryLabel}</button>}
          {onDismiss && (
            <button type="button" aria-label="Dismiss error" className={`${btnGhost} px-2`} onClick={onDismiss}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Inline form/field error under a control. */
export function FieldError({ children }: { children?: ReactNode }) {
  if (!children) return null
  return <p role="alert" className="mt-1.5 text-ui-xs text-[var(--danger)]">{children}</p>
}

/** Proper empty state: illustration block, heading, copy, optional action. */
export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="py-8 flex flex-col items-center text-center gap-2.5">
      {icon && (
        <div className="w-12 h-12 rounded-2xl bg-[var(--bg-tint)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--ink-muted)]">
          {icon}
        </div>
      )}
      <div className="text-sm font-medium text-[var(--ink-secondary)]">{title}</div>
      {body && <div className="text-xs text-[var(--ink-muted)] max-w-[320px] leading-relaxed">{body}</div>}
      {action && <div className="pt-1">{action}</div>}
    </div>
  )
}

/** Badge chip (built-in / custom / status). */
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'green' | 'amber' | 'rose' }) {
  const tones: Record<string, string> = {
    neutral: 'bg-[var(--bg-hover)] text-[var(--ink-secondary)]',
    accent: 'bg-[var(--accent-soft)] text-[var(--accent-text)]',
    green: 'bg-emerald-500/10 text-emerald-400',
    amber: 'bg-amber-500/10 text-amber-400/90',
    rose: 'bg-rose-500/10 text-rose-400',
  }
  return <span className={`text-3xs px-1.5 py-0.5 rounded ${tones[tone]} shrink-0`}>{children}</span>
}
