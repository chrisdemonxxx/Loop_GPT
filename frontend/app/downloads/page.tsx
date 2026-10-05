'use client'

import { useEffect } from 'react'
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
    // explain the manual path instead of pretending.
    alert('Your browser can install Loop GPT from its menu: "Install app" / "Add to Home screen". You are likely already installed, or the browser needs a first interaction.')
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
        </section>

        <section aria-label="Mobile" className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5">
          <div className="flex items-start gap-3">
            <Smartphone size={20} className="mt-0.5 shrink-0 text-[#e79d7f]" />
            <div className="min-w-0">
              <h2 className="text-[15px] font-medium text-slate-100">iOS & Android</h2>
              <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
                The mobile app is in development. Today, install the web app from your phone&apos;s browser
                menu (&ldquo;Add to Home Screen&rdquo;) — the phone layout is first-class.
              </p>
            </div>
          </div>
        </section>

        <section aria-label="Browser extension" className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5">
          <div className="flex items-start gap-3">
            <Puzzle size={20} className="mt-0.5 shrink-0 text-[#e79d7f]" />
            <div className="min-w-0">
              <h2 className="text-[15px] font-medium text-slate-100">Browser extension</h2>
              <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
                Not shipped yet — when it lands it will appear here first.
              </p>
            </div>
          </div>
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
    </main>
  )
}