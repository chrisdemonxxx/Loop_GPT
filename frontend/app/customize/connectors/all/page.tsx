'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, Cable, ChevronLeft, ExternalLink, Loader2, Plug, Plus, RefreshCw, Wrench,
} from 'lucide-react'
import { API_URL, authHeaders } from '../../../lib/api'
import { useWorkspaceProjects } from '../../../chat/hooks'
import { Badge, EmptyState, SectionHeader, Skeleton } from '../../../components/ui/primitives'

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

function typeFromLocation(search: string): string {
  const raw = search.startsWith('?') ? search.slice(1) : search
  const t = new URLSearchParams(raw).get('type')
  return t && t.trim() ? t.trim().slice(0, 64) : ''
}

function Avatar({ name }: { name: string }) {
  return (
    <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/5 bg-ink-800 text-[12px] font-semibold text-slate-300 shrink-0" aria-hidden>
      {name.slice(0, 2).toUpperCase()}
    </span>
  )
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
  const { workspaceId } = useWorkspaceProjects()
  const [types, setTypes] = useState<ConnectorType[]>([])
  const [configured, setConfigured] = useState<ConfiguredConnector[]>([])
  const [loadError, setLoadError] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [detail, setDetail] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('All categories')
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')

  const load = () =>
    fetch(`${API_URL}/api/agent/connectors`, { headers: authHeaders() })
      .then(async (r) => {
        if (!r.ok) throw new Error('load')
        const d = await r.json()
        if (!d || !Array.isArray(d.types)) throw new Error('load')
        setTypes(d.types)
        setConfigured(Array.isArray(d.configured) ? d.configured : [])
        setLoadError(false)
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoaded(true))
  useEffect(() => { load() }, [])

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

  // One flow, same shapes as ConnectorsTab (contract §3).
  const startOAuth = async (t: ConnectorType) => {
    setActionError(''); setBusy(true)
    try {
      if (!workspaceId) { setActionError('Open a project first (Projects in the sidebar), then connect.'); return }
      const res = await fetch(`${API_URL}/api/oauth-connector/init/${t.type}`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ workspaceId, redirectTo: '/chat' }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setActionError('Could not start the sign-in flow.'); return }
      window.location.href = d.authorizeUrl
    } catch { setActionError('Could not start the sign-in flow.') } finally { setBusy(false) }
  }

  const selected = detail ? types.find((t) => t.type === detail) : undefined
  const selectedConfigured = selected ? configured.filter((c) => c.type === selected.type) : []

  const saveCredentials = async () => {
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
      load()
    } finally { setBusy(false) }
  }

  const disconnect = async (id: string) => {
    setActionError(''); setBusy(true)
    try {
      await fetch(`${API_URL}/api/agent/connectors/${id}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {})
      setNotice('Disconnected.')
      load()
    } finally { setBusy(false) }
  }

  const test = async (id: string) => {
    setBusy(true)
    try {
      const res = await fetch(`${API_URL}/api/agent/connectors/${id}/test`, { method: 'POST', headers: authHeaders() })
      const d = await res.json().catch(() => ({}))
      setNotice(d.ok ? 'Connection OK' : (d.message || 'Test failed'))
      load()
    } finally { setBusy(false) }
  }

  const categories = useMemo(() => ['All categories', ...new Set(types.map((t) => t.category || 'Other').sort())], [types])
  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => types.filter((t) =>
    (category === 'All categories' || (t.category || 'Other') === category) &&
    (!q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || (t.category || '').toLowerCase().includes(q))
  ), [types, q, category])

  // ── detail view ─────────────────────────────────────────────────────────
  if (detail) {
    return (
      <main className="min-h-screen bg-[#08080a] px-5 py-6 max-w-4xl mx-auto text-slate-200">
        <Link href="/customize" className="inline-flex items-center gap-1.5 text-[12px] text-slate-400 transition hover:text-slate-200">
          <ArrowLeft size={14} /> Connectors
        </Link>
        <button type="button" onClick={backToDirectory} className="mt-4 inline-flex items-center gap-1.5 text-[12px] text-slate-400 transition hover:text-slate-200">
          <ChevronLeft size={14} /> All connectors
        </button>

        {loaded && !selected && (
          <div className="mt-6">
            <EmptyState
              icon={<Cable size={22} />}
              title="That connector does not exist"
              body={`No directory entry matches type "${detail}". It may have been removed.`}
              action={<button type="button" onClick={backToDirectory} className="mt-2 text-[12px] text-[#e79d7f] hover:underline">Back to the directory</button>}
            />
          </div>
        )}

        {selected && (
          <div className="mt-4 space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <Avatar name={selected.name} />
                <div className="min-w-0">
                  <h1 className="text-xl font-semibold text-slate-100">{selected.name}</h1>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-slate-500">{selected.description}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Badge>{selected.category}</Badge>
                    {selected.oauth && <Badge tone="accent">OAuth</Badge>}
                    {selected.tools && selected.tools.length > 0 && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-slate-500">
                        <Wrench size={10} /> {selected.tools.length} tools
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {actionError && <p className="text-[12px] text-rose-400" role="alert">{actionError}</p>}
            {notice && <p className="text-[12px] text-emerald-400" role="status">{notice}</p>}

            {/* Connected instances: test + disconnect (lifecycle §9.4). */}
            {selectedConfigured.length > 0 && (
              <div className="space-y-2">
                <SectionHeader title="Your connections" count={selectedConfigured.length} />
                {selectedConfigured.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] px-3.5 py-3">
                    <span className="min-w-0 text-[13px]">
                      <span className="text-slate-300">{c.name}</span>
                      {c.account && <span className="ml-2 text-[11px] text-slate-500">{c.account}</span>}
                      <span className="block text-[11px] text-slate-500">
                        {c.lastTestedAt ? (c.lastTestOk ? 'tested OK' : 'last test failed') : 'not tested yet'}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <button type="button" onClick={() => test(c.id)} disabled={busy} className="rounded-lg bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-slate-300 transition hover:bg-white/[0.08] disabled:opacity-50">
                        <RefreshCw size={12} className={busy ? 'inline animate-spin' : 'inline'} /> Test
                      </button>
                      <button type="button" onClick={() => disconnect(c.id)} disabled={busy} className="rounded-lg px-2.5 py-1.5 text-[12px] text-slate-400 transition hover:text-rose-400 disabled:opacity-50">
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
                  onClick={() => startOAuth(selected)}
                  disabled={busy}
                  className="inline-flex items-center gap-2 rounded-xl border border-[#c96442]/40 bg-[#c96442]/[0.08] px-4 py-2.5 text-[13px] font-medium text-[#e79d7f] transition hover:bg-[#c96442]/[0.14] disabled:opacity-50"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />} Connect {selected.name} with OAuth
                </button>
              </div>
            ) : selected.fields.length > 0 && (
              <div className="rounded-xl border border-white/[0.06] p-3.5">
                <div className="text-[13px] text-slate-300">Connect {selected.name}</div>
                <p className="mt-1 text-[11px] text-slate-500">The credential is validated against {selected.name} before it is saved.</p>
                <div className="mt-2.5 space-y-2">
                  {selected.fields.map((f) => (
                    <input
                      key={f.key}
                      type={f.secret ? 'password' : 'text'}
                      placeholder={f.placeholder || f.label}
                      value={fieldValues[f.key] || ''}
                      aria-label={f.label}
                      onChange={(e) => setFieldValues((cur) => ({ ...cur, [f.key]: e.target.value }))}
                      className="w-full rounded-lg border border-white/10 bg-ink-800 px-3 py-2 text-[13px] text-slate-200 placeholder:text-slate-600 focus:border-[#c96442]/50 focus:outline-none"
                    />
                  ))}
                  <button
                    type="button"
                    onClick={saveCredentials}
                    disabled={busy}
                    className="inline-flex items-center gap-2 rounded-lg border border-[#c96442]/40 bg-[#c96442]/[0.08] px-3.5 py-2 text-[13px] font-medium text-[#e79d7f] transition hover:bg-[#c96442]/[0.14] disabled:opacity-50"
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />} Connect
                  </button>
                </div>
              </div>
            )}

            {/* Tools region (blueprint: role=region "Tools"). */}
            {selected.tools && selected.tools.length > 0 && (
              <section aria-label="Tools" className="rounded-xl border border-white/[0.06] p-3.5">
                <div className="text-[13px] text-slate-300">Tools the agent gains</div>
                <ul className="mt-2 space-y-1.5">
                  {selected.tools.map((tool) => (
                    <li key={tool.suffix} className="flex items-start gap-2 text-[12px]">
                      <Wrench size={12} className="mt-0.5 shrink-0 text-slate-500" />
                      <span><span className="text-slate-200">{selected.type}__{tool.suffix}</span><span className="block text-slate-500">{tool.description}</span></span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Facts + related (blueprint right column). */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-white/[0.06] p-3.5 text-[12px]">
                <div className="mb-1.5 text-[11px] uppercase tracking-wider text-slate-500">Details</div>
                <div className="space-y-1 text-slate-400">
                  <div>Category: <span className="text-slate-300">{selected.category}</span></div>
                  <div>Sign-in: <span className="text-slate-300">{selected.oauth ? 'OAuth' : 'API credential'}</span></div>
                  {selected.docs && (
                    <div>Docs: <a href={selected.docs} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[#e79d7f] hover:underline">developer docs <ExternalLink size={10} /></a></div>
                  )}
                </div>
              </div>
              <section aria-label="Related connectors" className="rounded-xl border border-white/[0.06] p-3.5">
                <div className="mb-2 text-[11px] uppercase tracking-wider text-slate-500">Related connectors</div>
                <ul className="space-y-1.5">
                  {types.filter((t) => t.type !== selected.type && (t.category || 'Other') === (selected.category || 'Other')).slice(0, 6).map((t) => (
                    <li key={t.type}>
                      <button type="button" onClick={() => openDetail(t.type)} className="text-left text-[12px] text-slate-300 hover:text-[#e79d7f] hover:underline">
                        {t.name}
                      </button>
                    </li>
                  ))}
                  {types.filter((t) => t.type !== selected.type && (t.category || 'Other') === (selected.category || 'Other')).length === 0 && (
                    <li className="text-[12px] text-slate-600">No other connectors in this category yet.</li>
                  )}
                </ul>
              </section>
            </div>
          </div>
        )}
        {loadError && (
          <p className="mt-4 text-[12px] text-rose-400">
            Could not load the connector directory.
            <button type="button" onClick={load} className="ml-1.5 underline hover:text-rose-300">Retry</button>
          </p>
        )}
      </main>
    )
  }

  // ── directory view ──────────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-[#08080a] px-5 py-6 max-w-5xl mx-auto text-slate-200">
      <Link href="/customize" className="inline-flex items-center gap-1.5 text-[12px] text-slate-400 transition hover:text-slate-200">
        <ArrowLeft size={14} /> Connectors
      </Link>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Connector directory</h1>
          <p className="mt-0.5 text-[12px] text-slate-500">Browse every integration. Connected tools become callable by the agent.</p>
        </div>
        <Link href="/customize" className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-slate-300 transition hover:border-white/25 hover:text-slate-100">
          Manage connected
        </Link>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search connectors"
          aria-label="Search connectors"
          className="min-w-[12rem] flex-1 rounded-lg border border-white/10 bg-ink-800 px-3 py-2 text-[13px] text-slate-200 placeholder:text-slate-600 focus:border-[#c96442]/50 focus:outline-none"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Filter by category"
          className="rounded-lg border border-white/10 bg-ink-800 px-3 py-2 text-[13px] text-slate-200 focus:border-[#c96442]/50 focus:outline-none"
        >
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {loadError && (
        <p className="mt-4 text-[12px] text-rose-400">
          Could not load the connector directory.
          <button type="button" onClick={load} className="ml-1.5 underline hover:text-rose-300">Retry</button>
        </p>
      )}
      {!loaded && !loadError && (
        <div className="mt-4 grid grid-cols-2 gap-2.5 max-sm:grid-cols-1" role="status" aria-label="Loading connectors">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} variant="card" />)}
        </div>
      )}
      {loaded && !loadError && filtered.length === 0 && (
        <p className="mt-6 text-center text-[13px] text-slate-600">
          {q || category !== 'All categories' ? `No connectors match “${query || category}”.` : 'No connectors available yet.'}
        </p>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2.5 max-sm:grid-cols-1">
        {filtered.map((t) => {
          const cs = connectState(t, configured)
          return (
            <div key={t.type} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5 transition hover:border-white/[0.14]">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2.5">
                  <Avatar name={t.name} />
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-slate-100">{t.name}</div>
                    <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-slate-500">{t.description}</div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge>{t.category}</Badge>
                      {cs.state === 'connected' && <Badge tone="green">connected</Badge>}
                      {t.oauth && <Badge tone="accent">OAuth</Badge>}
                      {t.tools && t.tools.length > 0 && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-slate-500"><Wrench size={10} /> {t.tools.length}</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => openDetail(t.type)}
                className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-[#e79d7f] transition hover:underline"
              >
                <Plus size={12} /> {cs.label}
              </button>
            </div>
          )
        })}
      </div>
    </main>
  )
}