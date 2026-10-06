import Link from 'next/link'
import { Sparkles, ArrowLeft } from 'lucide-react'

const LEGAL_PAGES = [
  { href: '/privacy', label: 'Privacy Policy' },
  { href: '/terms', label: 'Terms of Service' },
  { href: '/cookies', label: 'Cookie Policy' },
  { href: '/acceptable-use', label: 'Acceptable Use' },
]

export default function LegalLayout({
  title,
  updated,
  children,
}: {
  title: string
  updated: string
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen">
      <nav className="max-w-6xl mx-auto flex items-center justify-between px-5 py-4 border-b border-white/[0.05]">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-[#c96442] flex items-center justify-center">
            <Sparkles size={14} className="text-white" />
          </div>
          <span className="font-semibold text-slate-100 text-[15px]">Loop GPT</span>
        </Link>
        <Link href="/" className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-300 transition">
          <ArrowLeft size={14} /> Back to home
        </Link>
      </nav>

      <div className="max-w-5xl mx-auto px-5 py-12 flex gap-10">
        {/* Sidebar nav */}
        <aside className="hidden lg:block w-48 shrink-0">
          <div className="sticky top-8 space-y-1">
            <p className="text-[11px] uppercase tracking-wider text-slate-600 mb-3 font-medium">Legal</p>
            {LEGAL_PAGES.map((p) => (
              <Link
                key={p.href}
                href={p.href}
                className="block px-3 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-100 hover:bg-white/[0.05] transition"
              >
                {p.label}
              </Link>
            ))}
          </div>
        </aside>

        {/* Content */}
        <main className="flex-1 min-w-0">
          <div className="mb-8">
            <h1 className="text-3xl font-semibold text-slate-100 mb-2">{title}</h1>
            <p className="text-sm text-slate-500">Last updated: {updated}</p>
          </div>

          <div className="prose-legal">{children}</div>

          {/* Mobile nav */}
          <div className="mt-12 pt-8 border-t border-white/[0.05] lg:hidden">
            <p className="text-[11px] uppercase tracking-wider text-slate-600 mb-3 font-medium">Other legal pages</p>
            <div className="flex flex-wrap gap-2">
              {LEGAL_PAGES.map((p) => (
                <Link
                  key={p.href}
                  href={p.href}
                  className="px-3 py-1.5 rounded-lg text-sm text-slate-400 hover:text-slate-100 glass transition"
                >
                  {p.label}
                </Link>
              ))}
            </div>
          </div>
        </main>
      </div>

      <footer className="max-w-6xl mx-auto px-5 py-8 border-t border-white/[0.05] text-center text-[13px] text-slate-600">
        © {new Date().getFullYear()} Loop GPT. All rights reserved.
      </footer>
    </div>
  )
}
