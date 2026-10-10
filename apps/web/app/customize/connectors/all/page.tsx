'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Cable, ChevronLeft, ExternalLink, Loader2, Plug, Plus, RefreshCw, Wrench,
} from 'lucide-react'
import { API_URL, authHeaders } from '../../../lib/api'
import { openOAuthPopup, oauthPopupNotice } from '../../../lib/oauthPopup'
import { useWorkspaceProjects } from '../../../chat/hooks'
import { AppPage } from '../../../components/AppPage'
import {
  Badge, EmptyState, ErrorState, LoadingState, SectionHeader, Skeleton, btnSecondary, inputCls, linkCls, panelCls, selectCls,
} from '@loop/ui'
import { BrandMark } from '../../../components/connectors/BrandMark'

interface ConnectorField { key: string; label: string; secret?: boolean; required?: boolean; placeholder?: string }
interface ToolSummary { suffix: string; description: string }
interface ConnectorType {
  type: string; name: string; description: string; category: string
  icon: string | null; oauth: boolean; fields: ConnectorField[]
  tools?: ToolSummary[]; docs?: string | null
}
interface ConfiguredConnector {
  id: string; type: string; name: string; enabled: boolean
  account: string | null; lastTestedAt: string | null; lastTestOk: boolean | null
}

interface DirectoryPayload {
  types: ConnectorType[]
  configured: ConfiguredConnector[]
}

function typeFromLocation(search: string): string {
  const raw = search.startsWith('?') ? search.slice(1) : search
  const t = new URLSearchParams(raw).get('type')
  return t && t.trim() ? t.trim().slice(0, 64) : ''
}

function Avatar({ name }: { name: string }) {
  return <BrandMark name={name} size={36} />
}

/** Derive the connect affordance per blueprint §9.4's lifecycle states. */
function connectState(t: ConnectorType, configured: ConfiguredConnector[]): { label: string; state: 'connected' | 'oauth' | 'available' } {
  if (configured.some((c) => c.type === t.type)) return { label: 'Connected', state: 'connected' }
  if (t.oauth) return { label: 'Sign in', state: 'oauth' }
  return { label: 'Connect', state: 'available' }
}

/**
 * Connector directory + detail (blueprint §9.4, contract
 * team/CONTRACT_S3_CONNECTORS.md). Directory = no ?type; detail = ?type=<slug>.
 * All connect/remove/test actions use the same request shapes as the
 * Connectors tab (one flow, two surfaces — the tests pin both).
 */
export default function ConnectorDirectoryPage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { workspaceId } = useWorkspaceProjects()

  const directory = useQuery<DirectoryPayload>({
    queryKey: ['connectors', 'directory'],
    queryFn: async () => {
      const r = await fetch(`${API_URL}/api/agent/connectors`, { headers: authHeaders() })
      if (!r.ok) throw new Error('load')
      const d = await r.json()
      if (!d || !Array.isArray(d.types)) throw new Error('load')
      return { types: d.types, configured: Array.isArray(d.configured) ? d.configured : [] }
    },
    enabled: typeof window !== 'undefined',
    retry: false,
  })
  const types = directory.data?.types ?? []
  const configured = directory.data?.configured ?? []
  const loaded = directory.isSuccess
  const loadError = directory.isError

  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ['connectors', 'directory'] }) }

  const [detail, setDetail] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('All categories')
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')

  // Query-param routing: ?type= on load + back/forward (popstate/hashchange).
  useEffect(() => {
    const sync = () => setDetail(typeFromLocation(window.location.search))
    sync()
    window.addEventListener('popstate', sync)
    window.addEventListener('hashchange', sync)
    return () => { window.removeEventListener('popstate', sync); window.removeEventListener('hashchange', sync) }
  }, [])

  const openDetail = (type: string) => {
    setDetail(type)
    setFieldValues({})
    setActionError('')
    setNotice('')
    router.push(`/customize/connectors/all?type=${encodeURIComponent(type)}`)
  }
  const backToDirectory = () => {
    setDetail('')
    setFieldValues({})
    setActionError('')
    setNotice('')
    if (typeFromLocation(window.location.search)) router.push('/customize/connectors/all')
  }

  // One flow, same shapes as ConnectorsTab (contract §3) — popup mode: the
  // provider consent opens in a centered popup and the backend callback
  // postMessages the outcome back (2026-10-05).
  async function startOAuth(t: ConnectorType) {
    setActionError(''); setNotice(''); setBusy(true)
    try {
      if (!workspaceId) { setActionError('Open a project first (Projects in the sidebar), then connect.'); return }
      const res = await fetch(`${API_URL}/api/oauth-connector/init/${t.type}`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ workspaceId, redirectTo: '/chat', via: 'popup' }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setActionError('Could not start the sign-in flow.'); return }
      const popup = openOAuthPopup(d.authorizeUrl, (result) => {
        const note = oauthPopupNotice(result, t.name)
        if (note.kind === 'ok') { setNotice(note.text); setActionError(''); refresh() }
        else if (note.kind === 'error') setActionError(note.text)
      })
      if (!popup) setActionError(oauthPopupNotice({ ok: false, error: 'popup_blocked' }, t.name).text)
    } catch { setActionError('Could not start the sign-in flow.') } finally { setBusy(false) }
  }

  const selected = detail ? types.find((t) => t.type === detail) : undefined
  const selectedConfigured = selected ? configured.filter((c) => c.type === selected.type) : []

  async function saveCredentials() {
    if (!selected || selected.oauth) return
    setActionError(''); setBusy(true)
    try {
      const res = await fetch(`${API_URL}/api/agent/connectors`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ type: selected.type, name: selected.name, config: fieldValues, enabled: true }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setActionError(d.error || 'Could not connect.'); return }
      setNotice(`${selected.name} connected.`)
      setFieldValues({})
      refresh()
    } finally { setBusy(false) }
  }

  async function disconnect(id: string) {
    setActionError(''); setBusy(true)
    try {
      await fetch(`${API_URL}/api/agent/connectors/${id}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {})
      setNotice('Disconnected.')
      refresh()
    } finally { setBusy(false) }
  }

  async function test(id: string) {
    setBusy(true)
    try {
      const res = await fetch(`${API_URL}/api/agent/connectors/${id}/test`, { method: 'POST', headers: authHeaders() })
      const d = await res.json().catch(() => ({}))
      setNotice(d.ok ? 'Connection OK' : (d.message || 'Test failed'))
      refresh()
    } finally { setBusy(false) }
  }

  const categories = useMemo(() => ['All categories', ...new Set(types.map((t) => t.category || 'Other').sort())], [types])
  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => types.filter((t) =>
    (category === 'All categories' || (t.category || 'Other') === category) &&
    (!q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || (t.category || '').toLowerCase().includes(q))
  ), [types, q, category])

  const loadErrorNotice = loadError && (
    <ErrorState
      title="Could not load the connector directory."
      onRetry={() => { void directory.refetch() }}
    />
  )

  // ── detail view ─────────────────────────────────────────────────────────
  if (detail) {
    return (
      <AppPage
        title={selected ? selected.name : 'Connectors'}
        documentTitle={selected ? selected.name : 'Connectors'}
        back={{ href: '/customize', label: 'Connectors' }}
        width="wide"
      >
        <button type="button" onClick={backToDirectory} className="mb-4 inline-flex items-center gap-1.5 rounded-md text-ui-xs text-[var(--ink-muted)] transition hover:text-[var(--ink-primary)]">
          <ChevronLeft size={14} aria-hidden /> All connectors
        </button>

        {loaded && !selected && (
          <div className="mt-6">
            <EmptyState
              icon={<Cable size={22} />}
              title="That connector does not exist"
              body={`No directory entry matches type "${detail}". It may have been removed.`}
              action={<button type="button" onClick={backToDirectory} className={`mt-2 text-ui-xs ${linkCls}`}>Back to the directory</button>}
            />
          </div>
        )}
        {!loaded && !loadError && <LoadingState label="Loading connector" variant="lines" count={3} />}

        {selected && (
          <div className="space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <Avatar name={selected.name} />
                <div className="min-w-0">
                  <p className="text-ui-sm leading-relaxed text-[var(--ink-muted)]">{selected.description}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Badge>{selected.category}</Badge>
                    {selected.oauth && <Badge tone="accent">OAuth</Badge>}
                    {selected.tools && selected.tools.length > 0 && (
                      <span className="inline-flex items-center gap-1 text-3xs text-[var(--ink-muted)]">
                        <Wrench size={10} aria-hidden /> {selected.tools.length} tools
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {actionError && <p className="text-ui-xs text-[var(--danger)]" role="alert">{actionError}</p>}
            {notice && <p className="text-ui-xs text-[var(--success)]" role="status">{notice}</p>}

            {/* Connected instances: test + disconnect (lifecycle §9.4). */}
            {selectedConfigured.length > 0 && (
              <div className="space-y-2">
                <SectionHeader title="Your connections" count={selectedConfigured.length} />
                {selectedConfigured.map((c) => (
                  <div key={c.id} className={`flex items-center justify-between gap-3 ${panelCls} px-3.5 py-3`}>
                    <span className="min-w-0 text-ui-sm">
                      <span className="text-[var(--ink-secondary)]">{c.name}</span>
                      {c.account && <span className="ml-2 text-2xs text-[var(--ink-muted)]">{c.account}</span>}
                      <span className="block text-2xs text-[var(--ink-muted)]">
                        {c.lastTestedAt ? (c.lastTestOk ? 'tested OK' : 'last test failed') : 'not tested yet'}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <button type="button" onClick={() => void test(c.id)} disabled={busy} className="rounded-lg bg-[var(--bg-hover)] px-2.5 py-1.5 text-ui-xs text-[var(--ink-secondary)] transition hover:bg-[var(--bg-hover-strong)] disabled:opacity-50">
                        <RefreshCw size={12} className={busy ? 'inline animate-spin' : 'inline'} aria-hidden /> Test
                      </button>
                      <button type="button" onClick={() => void disconnect(c.id)} disabled={busy} className="rounded-lg px-2.5 py-1.5 text-ui-xs text-[var(--ink-muted)] transition hover:text-[var(--danger)] disabled:opacity-50">
                        Disconnect
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Connect action — OAuth direct, or the credential fields. */}
            {selected.oauth ? (
              <div>
                <SectionHeader title="Sign in" />
                <button
                  type="button"
                  onClick={() => void startOAuth(selected)}
                  disabled={busy}
                  className={btnSecondary}
                >
                  {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Plug size={14} aria-hidden />} Connect {selected.name} with OAuth
                </button>
                <p className="mt-1.5 text-2xs leading-snug text-[var(--ink-muted)]">
                  If Google shows an &ldquo;unverified app&rdquo; screen, choose <span className="text-[var(--ink-secondary)]">Advanced → Continue</span>. It disappears once our verification completes.
                </p>
              </div>
            ) : selected.fields.length > 0 && (
              <div className={`${panelCls} p-3.5`}>
                <div className="text-ui-sm text-[var(--ink-secondary)]">Connect {selected.name}</div>
                <p className="mt-1 text-2xs text-[var(--ink-muted)]">The credential is validated against {selected.name} before it is saved.</p>
                <div className="mt-2.5 space-y-2">
                  {selected.fields.map((f) => (
                    <input
                      key={f.key}
                      type={f.secret ? 'password' : 'text'}
                      placeholder={f.placeholder || f.label}
                      value={fieldValues[f.key] || ''}
                      aria-label={f.label}
                      onChange={(e) => setFieldValues((cur) => ({ ...cur, [f.key]: e.target.value }))}
                      className={`${inputCls} text-ui-sm`}
                    />
                  ))}
                  <button
                    type="button"
                    onClick={() => void saveCredentials()}
                    disabled={busy}
                    className={btnSecondary}
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Plug size={14} aria-hidden />} Connect
                  </button>
                </div>
              </div>
            )}

            {/* Tools region (blueprint: role=region "Tools"). */}
            {selected.tools && selected.tools.length > 0 && (
              <section aria-label="Tools" className={`${panelCls} p-3.5`}>
                <div className="text-ui-sm text-[var(--ink-secondary)]">Tools the agent gains</div>
                <ul className="mt-2 space-y-1.5">
                  {selected.tools.map((tool) => (
                    <li key={tool.suffix} className="flex items-start gap-2 text-ui-xs">
                      <Wrench size={12} className="mt-0.5 shrink-0 text-[var(--ink-muted)]" aria-hidden />
                      <span><span className="text-[var(--ink-primary)]">{selected.type}__{tool.suffix}</span><span className="block text-[var(--ink-muted)]">{tool.description}</span></span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Facts + related (blueprint right column). */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className={`${panelCls} p-3.5 text-ui-xs`}>
                <div className="mb-1.5 text-2xs uppercase tracking-wider text-[var(--ink-muted)]">Details</div>
                <div className="space-y-1 text-[var(--ink-secondary)]">
                  <div>Category: <span className="text-[var(--ink-primary)]">{selected.category}</span></div>
                  <div>Sign-in: <span className="text-[var(--ink-primary)]">{selected.oauth ? 'OAuth' : 'API credential'}</span></div>
                  {selected.docs && (
                    <div>Docs: <a href={selected.docs} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1 ${linkCls}`}>developer docs <ExternalLink size={10} aria-hidden /></a></div>
                  )}
                </div>
              </div>
              <section aria-label="Related connectors" className={`${panelCls} p-3.5`}>
                <div className="mb-2 text-2xs uppercase tracking-wider text-[var(--ink-muted)]">Related connectors</div>
                <ul className="space-y-1.5">
                  {types.filter((t) => t.type !== selected.type && (t.category || 'Other') === (selected.category || 'Other')).slice(0, 6).map((t) => (
                    <li key={t.type}>
                      <button type="button" onClick={() => openDetail(t.type)} className={`text-left text-ui-xs text-[var(--ink-secondary)] ${linkCls}`}>
                        {t.name}
                      </button>
                    </li>
                  ))}
                  {types.filter((t) => t.type !== selected.type && (t.category || 'Other') === (selected.category || 'Other')).length === 0 && (
                    <li className="text-ui-xs text-[var(--ink-muted)]">No other connectors in this category yet.</li>
                  )}
                </ul>
              </section>
            </div>
          </div>
        )}
        {loadErrorNotice}
      </AppPage>
    )
  }

  // ── directory view ──────────────────────────────────────────────────────
  return (
    <AppPage
      title="Connector directory"
      description="Browse every integration. Connected tools become callable by the agent."
      back={{ href: '/customize', label: 'Connectors' }}
      width="wide"
      actions={<Link href="/customize" className={`${btnSecondary} px-3 py-1.5 text-ui-xs`}>Manage connected</Link>}
    >
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search connectors"
          aria-label="Search connectors"
          className={`${inputCls} min-w-[12rem] flex-1 text-ui-sm`}
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Filter by category"
          className={`${selectCls} text-ui-sm`}
        >
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {loadErrorNotice}
      {directory.isPending && (
        <div className="mt-4 grid grid-cols-2 gap-2.5 max-sm:grid-cols-1" role="status" aria-label="Loading connectors">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} variant="card" />)}
        </div>
      )}
      {loaded && filtered.length === 0 && (
        <p className="mt-6 text-center text-ui-sm text-[var(--ink-muted)]">
          {q || category !== 'All categories' ? `No connectors match “${query || category}”.` : 'No connectors available yet.'}
        </p>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2.5 max-sm:grid-cols-1">
        {filtered.map((t) => {
          const cs = connectState(t, configured)
          return (
            <div key={t.type} className={`h-[168px] flex flex-col ${panelCls} p-3.5`}>
              <div className="flex min-w-0 items-center gap-2.5">
                <Avatar name={t.name} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ui-sm font-medium text-[var(--ink-primary)]">{t.name}</div>
                  <div className="mt-0.5 line-clamp-1 text-ui-xs text-[var(--ink-secondary)]">{t.description}</div>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge>{t.category}</Badge>
                {cs.state === 'connected' && <Badge tone="green">connected</Badge>}
                {t.oauth ? <Badge tone="accent">OAuth</Badge> : <Badge>API key</Badge>}
                {t.tools && t.tools.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-3xs text-[var(--ink-muted)]"><Wrench size={10} aria-hidden /> {t.tools.length}</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => openDetail(t.type)}
                className="mt-auto inline-flex items-center justify-center gap-1.5 h-8 rounded-lg bg-[var(--accent-fill)] hover:bg-[var(--accent-fill-hover)] active:bg-[var(--accent-fill-active)] text-white text-ui-xs font-medium transition"
              >
                <Plus size={12} aria-hidden /> {cs.label}
              </button>
            </div>
          )
        })}
      </div>
    </AppPage>
  )
}
