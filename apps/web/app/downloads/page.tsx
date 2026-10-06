'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Download, MonitorSmartphone, Smartphone, Terminal, Puzzle } from 'lucide-react'

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
  useEffect(() => {
    document.title = 'Apps & extensions - Loop GPT'
  }, [])

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
    <main className="min-h-screen bg-[#08080a] px-5 py-8 max-w-3xl mx-auto text-slate-200">
      <Link href="/" className="inline-flex items-center gap-1.5 text-[12px] text-slate-400 transition hover:text-slate-200">
        <ArrowLeft size={14} /> Back
      </Link>
      <h1 className="mt-4 text-2xl font-semibold text-slate-100">Do more with Loop GPT, everywhere you work</h1>
      <p className="mt-2 max-w-prose text-[14px] leading-relaxed text-slate-400">
        One account, every surface. The chat you start in the browser continues on your installed app.
      </p>

      {/* Shipped surfaces — prominent, with actions. */}
      <div className="mt-8 space-y-4">
        <section aria-label="Desktop" className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <MonitorSmartphone size={20} className="mt-0.5 shrink-0 text-[#e79d7f]" />
              <div className="min-w-0">
                <h2 className="text-[15px] font-medium text-slate-100">Desktop — install the app</h2>
                <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
                  Loop GPT ships as an installable web app: your browser installs it from this site — no
                  separate download, always current. Works offline for your recent chats.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={install}
              className="shrink-0 inline-flex items-center gap-2 rounded-xl border border-[#c96442]/40 bg-[#c96442]/[0.08] px-4 py-2 text-[13px] font-medium text-[#e79d7f] transition hover:bg-[#c96442]/[0.14]"
            >
              <Download size={14} /> Install
            </button>
          </div>
          {installNote && <p role="status" className="mt-3 text-[12px] text-slate-400 border-t border-white/[0.05] pt-3">{installNote}</p>}
        </section>

        <section aria-label="Loop Code CLI" className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <Terminal size={20} className="mt-0.5 shrink-0 text-[#e79d7f]" />
              <div className="min-w-0">
                <h2 className="text-[15px] font-medium text-slate-100">Loop Code — the developer surface</h2>
                <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
                  API keys, usage, and the developer console for building on Loop GPT.
                </p>
              </div>
            </div>
            <Link
              href="/developer"
              className="shrink-0 inline-flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2 text-[13px] text-slate-200 transition hover:border-white/25 hover:text-white"
            >
              <Terminal size={14} /> Open Loop Code
            </Link>
          </div>
        </section>
      </div>

      {/* On the roadmap — one subdued strip, not two fake cards. */}
      <h2 className="mt-10 text-[11px] uppercase tracking-widest text-slate-600 font-medium">On the roadmap</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <section aria-label="Mobile" className="rounded-2xl border border-dashed border-white/[0.07] p-4 opacity-70">
          <div className="flex items-start gap-3">
            <Smartphone size={18} className="mt-0.5 shrink-0 text-slate-500" />
            <div className="min-w-0">
              <h3 className="text-[13px] font-medium text-slate-300">iOS & Android</h3>
              <p className="mt-1 text-[12px] leading-relaxed text-slate-600">
                In development. Today, install the web app from your phone&apos;s browser menu (&ldquo;Add to Home Screen&rdquo;).
              </p>
            </div>
          </div>
        </section>
        <section aria-label="Browser extension" className="rounded-2xl border border-dashed border-white/[0.07] p-4 opacity-70">
          <div className="flex items-start gap-3">
            <Puzzle size={18} className="mt-0.5 shrink-0 text-slate-500" />
            <div className="min-w-0">
              <h3 className="text-[13px] font-medium text-slate-300">Browser extension</h3>
              <p className="mt-1 text-[12px] leading-relaxed text-slate-600">
                Not shipped yet — it will land here first.
              </p>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}