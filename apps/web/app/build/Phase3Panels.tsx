'use client'

/**
 * Phase 3.7–3.9 panels (connectors, analytics, collaboration).
 * Kept separate from RunView / Phase2Panels so parallel Monaco/PTY work stays conflict-free.
 */

import { useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { BarChart3, Cable, Loader2, Users } from 'lucide-react'
import { Badge, SectionHeader, btnGhost, btnOutline, btnPrimary, textareaCls } from '@loop/ui'
import {
  getProjectAnalytics,
  getProjectCollab,
  heartbeatProjectPresence,
  listProjectConnectors,
  postProjectCollabChat,
  setProjectConnector,
  toUserFacingError,
  type ProjectAnalytics,
  type ProjectCollab,
  type ProjectConnector,
  type ProjectConnectorKind,
} from '@loop/loopit-client'

export function ConnectorsPanel({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<ProjectConnector[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [vaultStripe, setVaultStripe] = useState<boolean | null>(null)

  async function refresh() {
    try {
      const body = await listProjectConnectors(projectId)
      setRows(body.connectors ?? [])
      setError(null)
    } catch (cause) {
      setError(toUserFacingError(cause).message)
      setRows([])
    }
  }

  useEffect(() => {
    void refresh()
    // Best-effort: Loop-GPT connector catalog (session cookie). Offline → null.
    void fetch('/api/agent/connectors', { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) return
        const json = await res.json() as { configured?: Array<{ type?: string }> }
        setVaultStripe(Boolean(json.configured?.some((c) => c.type === 'stripe')))
      })
      .catch(() => setVaultStripe(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  return (
    <div className="pt-3 border-t border-[var(--border-subtle)] space-y-2">
      <SectionHeader title="Integrations" />
      <p className="text-3xs text-[var(--ink-muted)]">
        Stripe, email, and in-app AI. Add keys in Connectors or project secrets before turning one on.
        {vaultStripe === true ? ' Stripe key found in workspace connectors.' : ''}
      </p>
      {error && <p className="text-2xs text-[var(--danger)]">{error}</p>}
      <ul className="space-y-2">
        {rows.map((row) => {
          const kind = row.kind as ProjectConnectorKind
          const configured = row.status === 'configured' || (kind === 'stripe' && vaultStripe)
          const setupHref = row.secret_names?.length ? '#project-secrets' : '/customize/connectors/all'
          return (
            <li key={String(row.kind)} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <Cable size={12} className="text-[var(--ink-secondary)]" />
                <span className="text-ui-xs font-medium text-[var(--ink-primary)]">{row.label || row.kind}</span>
                <Badge tone={configured ? 'green' : 'neutral'}>
                  {configured ? 'Configured' : 'Off'}
                </Badge>
                {configured ? (
                  <button
                    type="button"
                    className={btnGhost}
                    disabled={busy === kind}
                    onClick={() => {
                      setBusy(kind)
                      void setProjectConnector(projectId, kind, !row.enabled)
                        .then(() => refresh())
                        .catch((cause) => setError(toUserFacingError(cause).message))
                        .finally(() => setBusy(null))
                    }}
                  >
                    {busy === kind ? <Loader2 size={11} className="animate-spin inline" /> : null}
                    {row.enabled ? 'Disable' : 'Enable'}
                  </button>
                ) : (
                  <Link href={setupHref} className={btnGhost}>Add keys</Link>
                )}
              </div>
              {row.description && <p className="mt-1 text-3xs text-[var(--ink-muted)]">{row.description}</p>}
              {row.note && <p className="mt-0.5 text-3xs text-[var(--ink-secondary)]">{row.note}</p>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export function AnalyticsPanel({ projectId }: { projectId: string }) {
  const [snap, setSnap] = useState<ProjectAnalytics | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    try {
      setSnap(await getProjectAnalytics(projectId))
      setError(null)
    } catch (cause) {
      setError(toUserFacingError(cause).message)
      setSnap(null)
    }
  }

  useEffect(() => { void refresh() }, [projectId])

  const topPaths = Object.entries(snap?.by_path ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
  const hasCounts = (snap?.page_views ?? 0) > 0 || (snap?.html_views ?? 0) > 0 || topPaths.length > 0

  return (
    <div className="pt-3 border-t border-[var(--border-subtle)] space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <BarChart3 size={14} className="text-[var(--ink-secondary)]" />
        <SectionHeader title="Analytics" />
        <button type="button" className={btnOutline} onClick={() => { void refresh() }}>Refresh</button>
      </div>
      {error && <p className="text-2xs text-[var(--danger)]">{error}</p>}
      {!error && !hasCounts && <p className="text-3xs text-[var(--ink-muted)]">No page views yet.</p>}
      {hasCounts && <div className="flex flex-wrap gap-4 text-ui-xs">
        <div>
          <p className="text-3xs text-[var(--ink-muted)]">Page views</p>
          <p className="text-ui-sm font-medium tabular-nums">{snap?.page_views ?? 0}</p>
        </div>
        <div>
          <p className="text-3xs text-[var(--ink-muted)]">HTML views</p>
          <p className="text-ui-sm font-medium tabular-nums">{snap?.html_views ?? 0}</p>
        </div>
        <div>
          <p className="text-3xs text-[var(--ink-muted)]">Last view</p>
          <p className="text-ui-xs">{snap?.last_view_at ? new Date(snap.last_view_at).toLocaleString() : '—'}</p>
        </div>
      </div>}
      {topPaths.length > 0 && (
        <ul className="space-y-1">
          {topPaths.map(([path, count]) => (
            <li key={path} className="flex justify-between gap-2 font-mono text-3xs text-[var(--ink-secondary)]">
              <span className="truncate">{path}</span>
              <span className="tabular-nums">{count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function CollaborationPanel({ projectId }: { projectId: string }) {
  const [collab, setCollab] = useState<ProjectCollab | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    try {
      setCollab(await getProjectCollab(projectId))
    } catch {
      setCollab(null)
    }
  }

  useEffect(() => {
    void heartbeatProjectPresence(projectId)
      .then(setCollab)
      .catch(() => { void refresh() })
    const timer = window.setInterval(() => {
      void heartbeatProjectPresence(projectId).then(setCollab).catch(() => {})
    }, 20_000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  async function onSend(event: FormEvent) {
    event.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      setCollab(await postProjectCollabChat(projectId, trimmed))
      setText('')
    } catch (cause) {
      setError(toUserFacingError(cause).message)
    } finally {
      setBusy(false)
    }
  }

  const peers = collab?.presence ?? []

  return (
    <div className="pt-3 border-t border-[var(--border-subtle)] space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Users size={14} className="text-[var(--ink-secondary)]" />
        <SectionHeader title="Collaboration" />
        <PresenceIndicator peers={peers} onlineCount={collab?.online_count ?? 0} />
      </div>
      <p className="text-3xs text-[var(--ink-muted)]">
        Notes for people working on this project.
      </p>
      {error && <p className="text-2xs text-[var(--danger)]">{error}</p>}
      <ul className="max-h-40 space-y-1.5 overflow-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2">
        {(collab?.messages ?? []).length === 0 && (
          <li className="text-3xs text-[var(--ink-muted)]">No notes yet.</li>
        )}
        {(collab?.messages ?? []).map((msg) => (
          <li key={msg.message_id} className="text-2xs">
            <span className="font-medium text-[var(--ink-primary)]">{msg.display_name}</span>
            <span className="ml-1.5 text-[var(--ink-muted)]">{msg.text}</span>
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => { void onSend(e) }} className="flex gap-2">
        <input
          className={`${textareaCls} py-2 flex-1`}
          placeholder="Add a note…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className={btnPrimary} disabled={busy || !text.trim()}>Send</button>
      </form>
    </div>
  )
}

export function PresenceIndicator({
  peers,
  onlineCount,
}: {
  peers: Array<{ actor_id: string; display_name: string }>
  onlineCount: number
}) {
  const names = peers.map((p) => p.display_name).slice(0, 4)
  return (
    <span className="inline-flex items-center gap-1.5 text-3xs text-[var(--ink-secondary)]" title={names.join(', ') || 'Nobody else online'}>
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${onlineCount > 0 ? 'bg-emerald-500' : 'bg-[var(--ink-muted)]'}`}
        aria-hidden
      />
      {onlineCount > 0 ? `${onlineCount} online` : 'Just you'}
      {names.length > 0 && onlineCount > 1 ? ` · ${names.join(', ')}` : ''}
    </span>
  )
}
