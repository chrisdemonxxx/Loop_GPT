'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Sparkles, AlertCircle } from 'lucide-react'
import { API_URL } from '../lib/api'
import Markdown from '../components/chat/Markdown'

/**
 * Public read-only share viewer (audit §8-15): /share?token=<hex> streams the
 * shared transcript via the unauthenticated token-gated endpoint. Query-string
 * routing keeps the static export intact; the owner revokes from the sidebar.
 */
interface SharedMessage {
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export default function SharePage() {
  const [data, setData] = useState<{ title: string; createdAt: string; messages: SharedMessage[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token') || ''
    if (!/^[0-9a-f]{32}$/.test(token)) { setError('This share link is invalid or has been revoked.'); setLoaded(true); return }
    fetch(`${API_URL}/api/share/${token}`)
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (ok && Array.isArray(body.messages)) setData(body)
        else setError(body.error || 'This share link is invalid or has been revoked.')
      })
      .catch(() => setError('Sharing is temporarily unavailable.'))
      .finally(() => setLoaded(true))
  }, [])

  return (
    <div className="min-h-[100dvh] bg-[#111113] text-slate-200">
      <header className="border-b border-white/[0.05] px-4 py-3 flex items-center gap-2.5 sticky top-0 bg-[#111113] z-10">
        <div className="w-7 h-7 rounded-lg bg-[#c96442] flex items-center justify-center shrink-0">
          <Sparkles size={14} className="text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-slate-100 truncate">{data?.title || 'Shared conversation'}</div>
          <div className="text-[11px] text-slate-500">Shared read-only transcript · Loop GPT</div>
        </div>
        <Link href="/" className="text-[12px] text-[#e79d7f] hover:underline shrink-0">Try Loop GPT →</Link>
      </header>

      <main className="max-w-[48rem] mx-auto px-4 py-6 space-y-6">
        {!loaded && <p className="text-[13px] text-slate-500 text-center py-10">Loading shared conversation…</p>}
        {loaded && error && (
          <div className="rounded-2xl border border-rose-500/20 bg-rose-500/[0.05] p-6 text-center space-y-2">
            <AlertCircle size={22} className="text-rose-400 mx-auto" />
            <p className="text-[13px] text-rose-300">{error}</p>
          </div>
        )}
        {data?.messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
            {m.role === 'user' ? (
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-[#1e1e21] border border-white/[0.07] px-4 py-3">
                <div className="whitespace-pre-wrap text-slate-100 text-[15px] leading-relaxed">{m.content}</div>
              </div>
            ) : (
              <div className="space-y-2">
                <Markdown content={m.content} />
                <div className="text-[11px] text-slate-500">{new Date(m.createdAt).toLocaleString()}</div>
              </div>
            )}
          </div>
        ))}
      </main>
    </div>
  )
}
