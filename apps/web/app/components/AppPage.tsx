'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowLeft, Blocks, Bot, Download, MessageSquare, Monitor, Moon, Settings, Sparkles, Sun } from 'lucide-react'
import { useTheme, type ThemeChoice } from '../lib/theme'

/** Baked at `next build` from LOOPIT_ENABLED. Empty keeps the Build link hidden. */
const LOOPIT_ENABLED = process.env.NEXT_PUBLIC_LOOPIT_ENABLED === '1'

export const APP_NAME = 'Loop GPT'

/** Standard `<title>` for client-rendered routes (static export). */
export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    if (!title) return
    document.title = `${title} - ${APP_NAME}`
  }, [title])
}

const NAV = [
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  ...(LOOPIT_ENABLED ? [{ href: '/build', label: 'Build', icon: Blocks }] : []),
  { href: '/agents', label: 'Loop Bot', icon: Bot },
  { href: '/artifacts', label: 'Files', icon: Download },
]

const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = { light: 'dark', dark: 'system', system: 'light' }

function isActive(pathname: string, href: string) {
  const path = pathname.replace(/\/+$/, '') || '/'
  return path === href || path.startsWith(`${href}/`)
}

/** The app bar every standalone route shares: brand, sections, Settings, theme. */
export function AppBar() {
  const { choice, setChoice } = useTheme()
  // Read the path after mount: works under the static export and in tests
  // that render a page without the Next router. Some test harnesses stub a
  // partial `location` (no pathname) — fall back to '' so isActive stays safe.
  const [pathname, setPathname] = useState('')
  useEffect(() => { setPathname(window.location?.pathname ?? '') }, [])
  const ThemeIcon = choice === 'light' ? Sun : choice === 'dark' ? Moon : Monitor
  const themeLabel = choice === 'light' ? 'Light' : choice === 'dark' ? 'Dark' : 'System'
  return (
    <header className="sticky top-0 z-30 border-b border-[var(--border-subtle)] bg-[var(--bg-overlay)] backdrop-blur pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-3 sm:px-5 h-12">
        <Link href="/chat" className="flex items-center gap-2 shrink-0 rounded-lg pr-1" aria-label={`${APP_NAME} home`}>
          <span className="w-7 h-7 rounded-lg bg-[var(--accent-fill)] flex items-center justify-center">
            <Sparkles size={14} className="text-white" aria-hidden />
          </span>
          <span className="hidden sm:inline font-semibold text-ui-md text-[var(--ink-primary)]">{APP_NAME}</span>
        </Link>
        <nav aria-label="Sections" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto no-scrollbar sm:ml-3">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href)
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-ui-sm transition ${
                  active
                    ? 'bg-[var(--bg-hover-strong)] text-[var(--ink-primary)] font-medium'
                    : 'text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)]'
                }`}
              >
                <Icon size={14} aria-hidden /> {label}
              </Link>
            )
          })}
        </nav>
        <button
          type="button"
          onClick={() => setChoice(NEXT_THEME[choice])}
          aria-label={`Theme: ${themeLabel}. Switch theme`}
          title={`Theme: ${themeLabel}`}
          className="tap-target shrink-0 rounded-lg p-1.5 text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition"
        >
          <ThemeIcon size={16} aria-hidden />
        </button>
        <Link
          href="/customize"
          aria-label="Settings"
          aria-current={isActive(pathname, '/customize') ? 'page' : undefined}
          title="Settings"
          className="tap-target shrink-0 rounded-lg p-1.5 text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition"
        >
          <Settings size={16} aria-hidden />
        </Link>
      </div>
    </header>
  )
}

/** The one back affordance: icon + destination label. */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      aria-label={`Back to ${label}`}
      className="inline-flex items-center gap-1.5 rounded-md text-ui-xs text-[var(--ink-muted)] transition hover:text-[var(--ink-primary)]"
    >
      <ArrowLeft size={14} aria-hidden /> {label}
    </Link>
  )
}

/** Page title block: back link, h1, description, meta row, actions. */
export function PageHeader({
  title, description, back, actions, meta, icon,
}: {
  title: ReactNode
  description?: ReactNode
  back?: { href: string; label: string }
  actions?: ReactNode
  meta?: ReactNode
  icon?: ReactNode
}) {
  return (
    <div className="mb-6">
      {back && <div className="mb-3"><BackLink {...back} /></div>}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-100 break-words">{icon}{title}</h1>
          {description && <p className="mt-1 max-w-prose text-ui-sm leading-relaxed text-[var(--ink-secondary)]">{description}</p>}
          {meta && <div className="mt-2 flex flex-wrap items-center gap-2 text-ui-xs text-[var(--ink-muted)]">{meta}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </div>
  )
}

const WIDTHS = { default: 'max-w-3xl', wide: 'max-w-6xl' } as const

/**
 * The shared page shell for every route outside the chat workspace. `fill`
 * hands the remaining viewport to a full-height app view (Loop Bot); the
 * other widths render a centred container with the standard padding.
 */
export function AppPage({
  children, width = 'default', title, documentTitle, description, back, actions, meta, icon, header,
}: {
  children: ReactNode
  width?: keyof typeof WIDTHS | 'fill'
  title?: ReactNode
  /** `<title>` text; defaults to `title` when it is a string. */
  documentTitle?: string | null
  description?: ReactNode
  back?: { href: string; label: string }
  actions?: ReactNode
  meta?: ReactNode
  icon?: ReactNode
  /** Replaces the PageHeader (custom hero blocks). */
  header?: ReactNode
}) {
  useDocumentTitle(documentTitle ?? (typeof title === 'string' ? title : null))
  const heading = header ?? (title !== undefined
    ? <PageHeader title={title} description={description} back={back} actions={actions} meta={meta} icon={icon} />
    : null)
  if (width === 'fill') {
    return (
      <div className="h-dvh flex flex-col bg-[var(--bg-base)] text-slate-200 overflow-hidden">
        <AppBar />
        <div className="flex-1 min-h-0 flex flex-col">{children}</div>
      </div>
    )
  }
  return (
    <div className="min-h-dvh bg-[var(--bg-base)] text-slate-200">
      <AppBar />
      <main className={`mx-auto ${WIDTHS[width]} px-5 py-8 pb-[max(2rem,env(safe-area-inset-bottom))]`}>
        {heading}
        {children}
      </main>
    </div>
  )
}
