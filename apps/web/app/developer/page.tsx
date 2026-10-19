'use client'

import { useState, type FormEvent } from 'react'
import { Check, Copy, Key, Plus, Terminal, Trash2, Zap } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, getStoredUser } from '../lib/api'
import { AppPage } from '../components/AppPage'
import { Badge, EmptyState, FieldError, LoadingState, StatCard, btnGhost, btnPrimary, inputCls, panelCls } from '@loop/ui'

interface ApiKeyRow {
  id: string
  name: string
  prefix: string
  spendCapUsd?: number | null
  concurrencyLimit?: number | null
  lastUsedAt: string | null
  createdAt: string
}
interface Overview {
  balanceUsd: number
  planName: string | null
  rateLimitPerMin: number
  keys: ApiKeyRow[]
  usage: { requests: number; tokensIn: number; tokensOut: number; units: number; spendUsd: number }
  recent: Array<{ id: string; kind: string; model: string; tokensIn: number; tokensOut: number; units: number; costUsd: number; createdAt: string }>
}

export default function DeveloperPage() {
  const user = getStoredUser()
  const queryClient = useQueryClient()
  const overview = useQuery<Overview>({
    queryKey: ['developer', 'overview'],
    queryFn: () => apiFetch<Overview>('/api/developer/overview'),
    enabled: typeof window !== 'undefined' && !!user,
    retry: false,
  })
  const ov = overview.data ?? null
  const [newKeyName, setNewKeyName] = useState('')
  const [issued, setIssued] = useState<{ id: string; key: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null)
  const [capInput, setCapInput] = useState('')
  const [concInput, setConcInput] = useState('')

  const createKey = useMutation({
    mutationFn: (name: string | undefined) =>
      apiFetch<{ id: string; key: string }>('/api/developer/keys', { method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: (created) => {
      setIssued({ id: created.id, key: created.key })
      setNewKeyName('')
      void queryClient.invalidateQueries({ queryKey: ['developer', 'overview'] })
    },
  })

  const revokeKey = useMutation({
    // A failed revoke still refreshes the list so rows reflect the truth.
    mutationFn: (id: string) => apiFetch(`/api/developer/keys/${id}`, { method: 'DELETE' }).catch(() => {}),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['developer', 'overview'] }) },
  })

  const updateKeyLimits = useMutation({
    mutationFn: ({ id, spendCapUsd, concurrencyLimit }: { id: string; spendCapUsd: number | null; concurrencyLimit: number | null }) =>
      apiFetch(`/api/developer/keys/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ spendCapUsd, concurrencyLimit }),
      }),
    onSuccess: () => {
      setEditingKeyId(null)
      void queryClient.invalidateQueries({ queryKey: ['developer', 'overview'] })
    },
  })

  const startEditLimits = (k: ApiKeyRow) => {
    setEditingKeyId(k.id)
    setCapInput(k.spendCapUsd != null ? String(k.spendCapUsd) : '')
    setConcInput(k.concurrencyLimit != null ? String(k.concurrencyLimit) : '')
  }

  const saveEditLimits = (id: string) => {
    const trimmedCap = capInput.trim()
    const trimmedConc = concInput.trim()
    const spendCapUsd = trimmedCap ? Number(trimmedCap) : null
    const concurrencyLimit = trimmedConc ? Math.round(Number(trimmedConc)) : null
    updateKeyLimits.mutate({ id, spendCapUsd, concurrencyLimit })
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (createKey.isPending) return
    createKey.mutate(newKeyName.trim() || undefined)
  }

  const copyKey = () => {
    if (!issued) return
    navigator.clipboard?.writeText(issued.key)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const curl = (key: string) => `curl https://api.loop-gpt.cyou/v1/chat/completions \\
  -H "Authorization: Bearer ${key || 'YOUR_API_KEY'}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"loop-large","messages":[{"role":"user","content":"Hello"}]}'`

  return (
    <AppPage
      title="Developer API"
      back={{ href: '/chat', label: 'Chat' }}
      meta={ov?.planName ? <Badge tone="accent">{ov.planName}</Badge> : undefined}
    >
      {!user && <div className="text-sm text-[var(--ink-secondary)]">Sign in to manage API keys.</div>}
      {user && overview.isPending && <LoadingState label="Loading API overview" />}

      {ov && (
        <div className="space-y-6">
          {/* Overview cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Balance" value={`$${ov.balanceUsd.toFixed(2)}`} />
            <StatCard label="Requests (30d)" value={String(ov.usage.requests)} />
            <StatCard label="Tokens (30d)" value={String(ov.usage.tokensIn + ov.usage.tokensOut)} />
            <StatCard label="Spend (30d)" value={`$${ov.usage.spendUsd.toFixed(2)}`} />
          </div>

          {/* Create key */}
          <section className={`${panelCls} p-4`}>
            <div className="text-sm font-medium text-[var(--ink-primary)] mb-3 flex items-center gap-2"><Key size={14} className="text-[var(--ink-muted)]" aria-hidden /> API keys</div>
            {issued && (
              <div className="mb-3 p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tint)]">
                <div className="text-2xs text-[var(--success)] mb-1.5">New key created — copy it now; it is shown only once.</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-ui-xs text-[var(--ink-primary)] bg-[var(--bg-code)] rounded px-2 py-1.5 truncate font-mono">{issued.key}</code>
                  <button type="button" onClick={copyKey} className={`${btnGhost} p-2`} aria-label="Copy key">
                    {copied ? <Check size={13} className="text-[var(--success)]" aria-hidden /> : <Copy size={13} aria-hidden />}
                  </button>
                </div>
              </div>
            )}
            <form onSubmit={onSubmit} className="flex gap-2">
              <input value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} placeholder="Key name (e.g. prod, local)" className={inputCls} />
              <button type="submit" disabled={createKey.isPending} className={btnPrimary}><Plus size={14} aria-hidden />Create</button>
            </form>
            {createKey.isError && <FieldError>{(createKey.error as { message?: string })?.message || 'Could not create key'}</FieldError>}
            <div className="mt-3 space-y-1">
              {ov.keys.length === 0 && <EmptyState title="No keys yet" />}
              {ov.keys.map((k) => (
                <div key={k.id} className="py-2 border-b border-[var(--border-subtle)] last:border-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-ui-sm text-[var(--ink-primary)] font-medium">
                        {k.name || 'Untitled'} <span className="text-[var(--ink-muted)] font-mono text-2xs">· {k.prefix}…</span>
                      </div>
                      <div className="text-2xs text-[var(--ink-muted)] flex flex-wrap items-center gap-2">
                        <span>{k.lastUsedAt ? `Last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : 'Never used'}</span>
                        <span>· Cap: {k.spendCapUsd != null ? `$${k.spendCapUsd.toFixed(2)}/30d` : 'Unlimited'}</span>
                        <span>· Concurrency: {k.concurrencyLimit != null ? k.concurrencyLimit : 'Default'}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => (editingKeyId === k.id ? setEditingKeyId(null) : startEditLimits(k))}
                        className="text-2xs text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] underline"
                      >
                        {editingKeyId === k.id ? 'Cancel' : 'Limits'}
                      </button>
                      <button type="button" onClick={() => revokeKey.mutate(k.id)} className="text-[var(--ink-muted)] hover:text-[var(--danger)] shrink-0" aria-label={`Revoke ${k.name || k.prefix}`}><Trash2 size={13} aria-hidden /></button>
                    </div>
                  </div>
                  {editingKeyId === k.id && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--border-subtle)]">
                      <input
                        type="number"
                        step="0.01"
                        min="0.01"
                        value={capInput}
                        onChange={(e) => setCapInput(e.target.value)}
                        placeholder="30d cap USD (blank = none)"
                        aria-label="30-day spend cap USD"
                        className={`${inputCls} max-w-[180px] text-ui-xs`}
                      />
                      <input
                        type="number"
                        step="1"
                        min="1"
                        max="1000"
                        value={concInput}
                        onChange={(e) => setConcInput(e.target.value)}
                        placeholder="Max concurrent (blank = none)"
                        aria-label="Max concurrent requests"
                        className={`${inputCls} max-w-[190px] text-ui-xs`}
                      />
                      <button
                        type="button"
                        disabled={updateKeyLimits.isPending}
                        onClick={() => saveEditLimits(k.id)}
                        className={`${btnPrimary} text-ui-xs py-1 px-2.5`}
                      >
                        Save limits
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* Quick start */}
          <section className={`${panelCls} p-4`}>
            <div className="text-sm font-medium text-[var(--ink-primary)] mb-2 flex items-center gap-2"><Terminal size={14} className="text-[var(--ink-muted)]" aria-hidden /> Quick start</div>
            <p className="text-ui-xs text-[var(--ink-muted)] mb-2">OpenAI-compatible. Chat completions, embeddings, image & video generation, and usage metering.</p>
            <pre className="text-2xs text-[var(--ink-primary)] bg-[var(--bg-code)] rounded-lg p-3 overflow-x-auto font-mono">{curl(issued?.key || '')}</pre>
          </section>

          {/* Recent usage */}
          <section className={`${panelCls} p-4`}>
            <div className="text-sm font-medium text-[var(--ink-primary)] mb-2 flex items-center gap-2"><Zap size={14} className="text-[var(--ink-muted)]" aria-hidden /> Recent usage</div>
            {ov.recent.length === 0 && <EmptyState title="No usage yet" />}
            <div className="space-y-1">
              {ov.recent.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 py-1 border-b border-[var(--border-subtle)] last:border-0 text-ui-xs">
                  <span className="text-[var(--ink-primary)]">{r.kind} · {r.model}</span>
                  <span className="text-[var(--ink-muted)]">{r.tokensIn + r.tokensOut} tok · ${r.costUsd.toFixed(4)} · {new Date(r.createdAt).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </AppPage>
  )
}
