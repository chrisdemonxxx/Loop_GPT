'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Download, MonitorSmartphone, Smartphone, Terminal, Puzzle } from 'lucide-react'
import { AppPage } from '../components/AppPage'
import { btnGhost, btnSecondary, panelCls } from '@loop/ui'

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
}

/**
 * Apps & extensions (blueprint §9.6 → contract team/CONTRACT_S3_ROUTES.md).
 * Every claim is real: the PWA shell is shipped (`build/pwa.mjs`), the mobile
 * app is in development, the browser extension is not shipped, and the CLI
 * surface lives at /developer. No invented store links.
 */
export default function DownloadsPage() {
  const [installNote, setInstallNote] = useState('')

  const install = () => {
    const evt = (window as unknown as { deferredPrompt?: InstallPromptEvent }).deferredPrompt
    if (evt) {
      void evt.prompt()
      return
    }
    // No deferred prompt (browser already installed, or not eligible):
    // explain the manual path inline instead of a native alert().
    setInstallNote('Your browser installs Loop GPT from its menu: "Install app" / "Add to Home screen". If you don\'t see it, you\'re likely already installed, or the browser needs one more interaction first.')
  }

  return (
    <AppPage
      documentTitle="Apps & extensions"
      title="Do more with Loop GPT, everywhere you work"
      description="One account, every surface. The chat you start in the browser continues on your installed app."
      back={{ href: '/', label: 'Home' }}
    >
      {/* Shipped surfaces — prominent, with actions. */}
      <div className="space-y-4">
        <section aria-label="Desktop" className={`${panelCls} p-5`}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <MonitorSmartphone size={20} className="mt-0.5 shrink-0 text-[var(--accent-text)]" aria-hidden />
              <div className="min-w-0">
                <h2 className="text-ui-md font-medium text-[var(--ink-primary)]">Desktop — install the app</h2>
                <p className="mt-1 text-ui-xs leading-relaxed text-[var(--ink-muted)]">
                  Loop GPT ships as an installable web app: your browser installs it from this site — no
                  separate download, always current. Works offline for your recent chats.
                </p>
              </div>
            </div>
            <button type="button" onClick={install} className={`${btnSecondary} shrink-0`}>
              <Download size={14} aria-hidden /> Install
            </button>
          </div>
          {installNote && (
            <p role="status" className="mt-3 text-ui-xs text-[var(--ink-secondary)] border-t border-[var(--border-subtle)] pt-3">{installNote}</p>
          )}
        </section>

        <section aria-label="Loop Code CLI" className={`${panelCls} p-5`}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <Terminal size={20} className="mt-0.5 shrink-0 text-[var(--accent-text)]" aria-hidden />
              <div className="min-w-0">
                <h2 className="text-ui-md font-medium text-[var(--ink-primary)]">Loop Code — the developer surface</h2>
                <p className="mt-1 text-ui-xs leading-relaxed text-[var(--ink-muted)]">
                  API keys, usage, and the developer console for building on Loop GPT.
                </p>
              </div>
            </div>
            <Link href="/developer" className={`${btnGhost} shrink-0`}>
              <Terminal size={14} aria-hidden /> Open Loop Code
            </Link>
          </div>
        </section>
      </div>

      {/* On the roadmap — one subdued strip, not two fake cards. */}
      <h2 className="mt-10 text-2xs uppercase tracking-widest text-[var(--ink-muted)] font-medium">On the roadmap</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <section aria-label="Mobile" className="rounded-2xl border border-dashed border-[var(--border-subtle)] p-4 opacity-70">
          <div className="flex items-start gap-3">
            <Smartphone size={18} className="mt-0.5 shrink-0 text-[var(--ink-muted)]" aria-hidden />
            <div className="min-w-0">
              <h3 className="text-ui-sm font-medium text-[var(--ink-secondary)]">iOS &amp; Android</h3>
              <p className="mt-1 text-ui-xs leading-relaxed text-[var(--ink-muted)]">
                In development. Today, install the web app from your phone&apos;s browser menu (&ldquo;Add to Home Screen&rdquo;).
              </p>
            </div>
          </div>
        </section>
        <section aria-label="Browser extension" className="rounded-2xl border border-dashed border-[var(--border-subtle)] p-4 opacity-70">
          <div className="flex items-start gap-3">
            <Puzzle size={18} className="mt-0.5 shrink-0 text-[var(--ink-muted)]" aria-hidden />
            <div className="min-w-0">
              <h3 className="text-ui-sm font-medium text-[var(--ink-secondary)]">Browser extension</h3>
              <p className="mt-1 text-ui-xs leading-relaxed text-[var(--ink-muted)]">
                Not shipped yet — it will land here first.
              </p>
            </div>
          </div>
        </section>
      </div>
    </AppPage>
  )
}
