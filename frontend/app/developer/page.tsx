'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Key, Plus, Trash2, Copy, Check, Zap, Loader2, Terminal } from 'lucide-react'
import { apiFetch, getStoredUser } from '../lib/api'

interface ApiKeyRow { id: string; name: string; prefix: string; lastUsedAt: string | null; createdAt: string }
interface Overview {
  balanceUsd: number
  planName: string | null
  rateLimitPerMin: number
  keys: ApiKeyRow[]
  usage: { requests: number; tokensIn: number; tokensOut: number; units: number; spendUsd: number }
  recent: Array<{ id: string; kind: string; model: string; tokensIn: number; tokensOut: number; units: number; costUsd: number; createdAt: string }>
}

const inputCls = 'mt-1 w-full bg-ink-800 border border-white/10 rounded-lg px-3 py-2 text-slate-100 text-sm focus:outline-none focus:accent-ring placeholder-slate-600'

export default function DeveloperPage() {
  const user = getStoredUser()
  const [ov, setOv] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [newKeyName, setNewKeyName] = useState('')
  const [issued, setIssued] = useState<{ id: string; key: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    try { setOv(await apiFetch<Overview>('/api/developer/overview')) } catch { setOv(null) } finally { setLoading(false) }
  }
  useEffect(() => { if (user) load() }, [user?.id])

  const createKey = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError('')
    try {
      const k = await apiFetch<any>('/api/developer/keys', { method: 'POST', body: JSON.stringify({ name: newKeyName.trim() || undefined }) })
      setIssued({ id: k.id, key: k.key }); setNewKeyName(''); load()
    } catch (err: any) { setError(err?.message || 'Could not create key') } finally { setBusy(false) }
  }
  const revoke = async (id: string) => { await apiFetch(`/api/developer/keys/${id}`, { method: 'DELETE' }).catch(() => {}); load() }

  const curl = (key: string) => `curl https://api.loop-gpt.cyou/v1/chat/completions \\
  -H "Authorization: Bearer ${key || 'YOUR_API_KEY'}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"loop-large","messages":[{"role":"user","content":"Hello"}]}'`

  return (
    <div className="min-h-screen bg-[#111113] text-slate-200">
      <div className="max-w-3xl mx-auto px-5 py-8">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Link href="/chat" className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-300 transition"><ArrowLeft size={14} /> Back</Link>
            <h1 className="text-xl font-semibold text-slate-100">Developer API</h1>
          </div>
          {ov?.planName && <span className="text-[11px] px-2 py-1 rounded bg-white/5 text-slate-400">{ov.planName}</span>}
        </div>

        {!user && <div className="text-sm text-slate-400">Sign in to manage API keys.</div>}
        {user && loading && <div className="text-sm text-slate-500 py-8 text-center"><Loader2 size={16} className="animate-spin inline" /> Loading…</div>}

        {ov && (
          <div className="space-y-6">
            {/* Overview cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Card label="Balance" value={`$${ov.balanceUsd.toFixed(2)}`} />
              <Card label="Requests (30d)" value={String(ov.usage.requests)} />
              <Card label="Tokens (30d)" value={String(ov.usage.tokensIn + ov.usage.tokensOut)} />
              <Card label="Spend (30d)" value={`$${ov.usage.spendUsd.toFixed(2)}`} />
            </div>

            {/* Create key */}
            <section className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
              <div className="text-sm font-medium text-slate-200 mb-3 flex items-center gap-2"><Key size={14} className="text-slate-500" /> API keys</div>
              {issued && (
                <div className="mb-3 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                  <div className="text-[11px] text-emerald-300 mb-1.5">New key created — copy it now; it is shown only once.</div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-[12px] text-emerald-200 bg-black/30 rounded px-2 py-1.5 truncate font-mono">{issued.key}</code>
                    <button onClick={() => { navigator.clipboard?.writeText(issued.key); setCopied(true); setTimeout(() => setCopied(false), 1500) }} className="p-2 rounded bg-white/10 hover:bg-white/15 transition" aria-label="Copy key">{copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}</button>
                  </div>
                </div>
              )}
              <form onSubmit={createKey} className="flex gap-2">
                <input value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} placeholder="Key name (e.g. prod, local)" className={inputCls} />
                <button type="submit" disabled={busy} className="px-4 rounded-lg text-white bg-[#c96442] hover:bg-[#b5593a] transition text-sm font-medium flex items-center gap-1.5 disabled:opacity-50"><Plus size={14} />Create</button>
              </form>
              {error && <div className="text-xs text-rose-400 mt-2">{error}</div>}
              <div className="mt-3 space-y-1">
                {ov.keys.length === 0 && <div className="text-[12px] text-slate-500">No keys yet.</div>}
                {ov.keys.map((k) => (
                  <div key={k.id} className="flex items-center justify-between gap-3 py-1.5 border-b border-white/[0.05] last:border-0">
                    <div className="min-w-0">
                      <div className="text-[13px] text-slate-200 font-medium">{k.name || 'Untitled'} <span className="text-slate-600 font-mono text-[11px]">· {k.prefix}…</span></div>
                      <div className="text-[11px] text-slate-500">{k.lastUsedAt ? `Last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : 'Never used'}</div>
                    </div>
                    <button onClick={() => revoke(k.id)} className="text-slate-500 hover:text-rose-400 shrink-0" aria-label={`Revoke ${k.name}`}><Trash2 size={13} /></button>
                  </div>
                ))}
              </div>
            </section>

            {/* Quick start */}
            <section className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
              <div className="text-sm font-medium text-slate-200 mb-2 flex items-center gap-2"><Terminal size={14} className="text-slate-500" /> Quick start</div>
              <p className="text-[12px] text-slate-500 mb-2">OpenAI-compatible. Chat completions, embeddings, image & video generation, and usage metering.</p>
              <pre className="text-[11px] text-slate-300 bg-black/40 rounded-lg p-3 overflow-x-auto font-mono">{curl(issued?.key || '')}</pre>
            </section>

            {/* Recent usage */}
            <section className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
              <div className="text-sm font-medium text-slate-200 mb-2 flex items-center gap-2"><Zap size={14} className="text-slate-500" /> Recent usage</div>
              {ov.recent.length === 0 && <div className="text-[12px] text-slate-500">No usage yet.</div>}
              <div className="space-y-1">
                {ov.recent.map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-3 py-1 border-b border-white/[0.04] last:border-0 text-[12px]">
                    <span className="text-slate-300">{r.kind} · {r.model}</span>
                    <span className="text-slate-500">{r.tokensIn + r.tokensOut} tok · ${r.costUsd.toFixed(4)} · {new Date(r.createdAt).toLocaleDateString()}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="text-lg font-semibold text-slate-100 mt-0.5">{value}</div>
    </div>
  )
}
