'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Cable, Check, ChevronDown, ExternalLink, Globe, Loader2, Plug, Plus, RefreshCw, X,
} from 'lucide-react'
import { API_URL, authHeaders, getStoredUser } from '../../lib/api'
import { openOAuthPopup, oauthPopupNotice } from '../../lib/oauthPopup'
import { Dialog } from '@loop/ui'
import { Badge, btnGhost, btnPrimary, EmptyState, inputCls, SearchInput, SectionHeader, StatusDot } from '../ui/primitives'
import { BrandMark } from '../connectors/BrandMark'

interface ConnectorField { key: string; label: string; secret?: boolean; required?: boolean; placeholder?: string }
interface ConnectorType { type: string; name: string; description: string; category: string; icon: string | null; oauth: boolean; fields: ConnectorField[] }
interface ConfiguredConnector {
  id: string; type: string; name: string; enabled: boolean
  fields: Record<string, boolean>; account: string | null
  lastTestedAt: string | null; lastTestOk: boolean | null
}
interface MarketplaceEntry { type: string; name: string; docs: string | null }
interface CustomTool { id: string; name: string; description?: string; method: string; url: string }

const OAUTH_LABEL: Record<string, string> = {
  google_drive: 'Google', gmail: 'Google', google_calendar: 'Google', google_sheets: 'Google', github: 'GitHub',
}

function timeAgo(iso: string | null): string {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function Avatar({ name }: { name: string }) {
  return <BrandMark name={name} size={32} />
}

/**
 * Connectors: connected list with live status, available grid by category,
 * the marketplace (user-owned OAuth apps), Custom HTTP API (former Builder),
 * and MCP servers under "Advanced".
 */
export default function ConnectorsTab({ workspaceId }: { workspaceId?: string | null }) {
  const [data, setData] = useState<{ types: ConnectorType[]; configured: ConfiguredConnector[]; marketplace: MarketplaceEntry[] }>({ types: [], configured: [], marketplace: [] })
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [showMarketplace, setShowMarketplace] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [mcpAdmin, setMcpAdmin] = useState(false)
  useEffect(() => { setMcpAdmin(getStoredUser()?.role === 'admin') }, [])

  // Credential modal (API-key connectors + Custom HTTP).
  const [addType, setAddType] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [addBusy, setAddBusy] = useState(false)

  // Marketplace OAuth-app modal.
  const [marketType, setMarketType] = useState<MarketplaceEntry | null>(null)
  const [clientCreds, setClientCreds] = useState({ clientId: '', clientSecret: '' })
  const [oauthBusy, setOauthBusy] = useState<string | null>(null)

  // Test connection state per connector id.
  const [testing, setTesting] = useState<string | null>(null)
  const [testMsg, setTestMsg] = useState<Record<string, string>>({})

  const load = () =>
    fetch(`${API_URL}/api/agent/connectors`, { headers: authHeaders() })
      .then(async (r) => {
        if (!r.ok) throw new Error('load')
        const d = await r.json()
        if (!d || !Array.isArray(d.types) || !Array.isArray(d.configured)) throw new Error('load')
        setData({ types: d.types, configured: d.configured, marketplace: Array.isArray(d.marketplace) ? d.marketplace : [] })
        setLoadError('')
      })
      .catch(() => setLoadError('Could not load connectors.'))
      .finally(() => setLoaded(true))
  useEffect(() => { load() }, [])

  const selected = data.types.find((t) => t.type === addType)

  const startOAuth = async (type: string, creds?: { clientId: string; clientSecret: string }): Promise<boolean> => {
    setError('')
    if (!workspaceId) { setError('Open a project first (Projects in the sidebar), then connect.'); return false }
    setOauthBusy(type)
    try {
      const res = await fetch(`${API_URL}/api/oauth-connector/init/${type}`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ workspaceId, redirectTo: '/chat', via: 'popup', ...(creds || {}) }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError('Could not start the sign-in flow.'); return false }
      // Popup flow (2026-10-05): the provider consent opens in a centered
      // popup; the backend callback postMessages the outcome and closes.
      const providerName = selected?.name || data.configured.find((c) => c.type === type)?.name || 'That connector'
      const popup = openOAuthPopup(d.authorizeUrl, (result) => {
        const note = oauthPopupNotice(result, providerName)
        if (note.kind === 'ok') { setError(''); load() }
        else if (note.kind === 'error') setError(note.text)
      })
      if (!popup) { setError(oauthPopupNotice({ ok: false, error: 'popup_blocked' }, providerName).text); return false }
      return true
    } catch { setError('Could not start the sign-in flow.'); return false } finally { setOauthBusy(null) }
  }

  const add = async () => {
    if (!selected) return
    setError(''); setAddBusy(true)
    try {
      const res = await fetch(`${API_URL}/api/agent/connectors`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ type: addType, name: selected.name, config: fields, enabled: true }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error || 'Could not connect.'); return }
      setFields({}); setAddType(null); load()
    } finally { setAddBusy(false) }
  }

  const remove = async (id: string) => {
    await fetch(`${API_URL}/api/agent/connectors/${id}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {})
    load()
  }

  const test = async (id: string) => {
    setTesting(id)
    try {
      const res = await fetch(`${API_URL}/api/agent/connectors/${id}/test`, { method: 'POST', headers: authHeaders() })
      const d = await res.json().catch(() => ({}))
      setTestMsg((p) => ({ ...p, [id]: d.ok ? 'Connection OK' : (d.message || 'Failed') }))
      load()
    } finally { setTesting(null) }
  }

  const q = query.trim().toLowerCase()
  const filtered = useMemo(
    () => data.types.filter((t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.category.toLowerCase().includes(q)),
    [data.types, q],
  )
  const categories = useMemo(() => {
    const map = new Map<string, ConnectorType[]>()
    for (const t of filtered) {
      const cat = t.category || 'Other'
      if (!map.has(cat)) map.set(cat, [])
      map.get(cat)!.push(t)
    }
    return [...map.entries()]
  }, [filtered])

  const configuredTypes = new Set(data.configured.map((c) => c.type))

  return (
    <div className="space-y-4 text-sm">
      {/* Directory hand-off (blueprint §9.4: "Browse connectors"). */}
      <Link href="/customize/connectors/all" className="inline-flex items-center gap-1.5 text-ui-xs text-[var(--accent-text)] hover:underline">
        <Globe size={12} /> Browse the full connector directory
      </Link>

      {/* Connected */}
      <SectionHeader title="Connected" count={data.configured.length} />
      {loaded && !loadError && data.configured.length === 0 && (
        <p className="text-xs text-[var(--ink-muted)]">Nothing connected yet</p>
      )}
      {loadError && (
        <div className="text-xs text-[var(--danger)] flex items-center gap-2">
          <span>{loadError}</span>
          <button type="button" onClick={() => load()} className="underline hover:text-[var(--danger)]">Retry</button>
        </div>
      )}
      {data.configured.map((c) => {
        const type = data.types.find((t) => t.type === c.type)
        const ok = c.lastTestOk !== false && c.enabled
        return (
          <div key={c.id} className="px-3 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] flex items-center gap-3">
            <Avatar name={c.name} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-[var(--ink-primary)] truncate">{c.name}</span>
                {c.account && <span className="text-2xs text-[var(--ink-muted)] truncate">{c.account}</span>}
              </div>
              <div className="text-2xs text-[var(--ink-muted)] mt-0.5">
                {c.lastTestedAt ? `tested ${timeAgo(c.lastTestedAt)}` : 'not tested yet'}
                {testMsg[c.id] && <span className={c.lastTestOk ? ' text-[var(--success)]' : ' text-[var(--danger)]'}> · {testMsg[c.id]}</span>}
              </div>
            </div>
            <Badge tone={ok ? 'green' : 'amber'}>{ok ? 'Connected' : 'Needs attention'}</Badge>
            {type?.oauth && <span className="shrink-0 text-3xs uppercase tracking-wide text-sky-300/80">OAuth</span>}
            <button
              onClick={() => test(c.id)}
              disabled={testing === c.id}
              className="shrink-0 p-1.5 rounded-lg text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
              aria-label={`Test ${c.name}`}
            ><RefreshCw size={13} className={testing === c.id ? 'animate-spin' : ''} /></button>
            <button
              onClick={() => remove(c.id)}
              className="shrink-0 px-2.5 py-1.5 rounded-lg text-ui-xs text-[var(--ink-secondary)] hover:text-[var(--danger)] hover:bg-[var(--bg-hover)] transition"
            >Disconnect</button>
          </div>
        )
      })}

      {/* Search */}
      <SearchInput value={query} onChange={setQuery} placeholder="Search connectors…" resultCount={q ? filtered.length : null} />
      {error && <div className="text-xs text-[var(--danger)]">{error}</div>}

      {/* Available by category */}
      {categories.map(([cat, types]) => (
        <div key={cat} className="space-y-2">
          <SectionHeader title={cat} count={types.length} />
          {/* P5: one card per row below sm — the 2-col grid was what clipped
              the title to `GitHu`/`GitLat`/`Sentr` (title + `+ Add` on one line). */}
          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            {types.map((t) => {
              const connected = configuredTypes.has(t.type)
              return (
                <article key={t.type} className="h-[148px] flex flex-col rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] p-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Avatar name={t.name} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-ui-sm font-medium text-[var(--ink-primary)]">{t.name}</div>
                      <div className="text-3xs uppercase tracking-wide text-[var(--ink-muted)]">{t.oauth ? 'OAuth' : 'API key'}</div>
                    </div>
                    {connected && <Badge tone="green">connected</Badge>}
                  </div>
                  <p className="mt-2 text-ui-xs text-[var(--ink-secondary)] line-clamp-1">{t.description}</p>
                  <div className="mt-auto pt-2">
                    {t.oauth && OAUTH_LABEL[t.type] ? (
                      <button
                        onClick={() => startOAuth(t.type)}
                        disabled={oauthBusy === t.type}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--accent-fill)] text-white text-ui-xs font-medium disabled:opacity-50"
                      >
                        {oauthBusy === t.type ? <Loader2 size={12} className="animate-spin" /> : null} Connect with {OAUTH_LABEL[t.type]}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setAddType(t.type); setFields({}); setError('') }}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--bg-hover)] text-[var(--ink-primary)] text-ui-xs font-medium hover:bg-[var(--bg-hover-strong)]"
                      >
                        <Plus size={12} /> Add
                      </button>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        </div>
      ))}
      {q && filtered.length === 0 && <p className="text-center text-xs text-[var(--ink-muted)] py-3">No connectors match “{query}”.</p>}

      {/* Credential panel (inline) */}
      {selected && !selected.oauth && (
        <div className="p-3.5 rounded-xl border border-dashed border-[var(--border-subtle)] space-y-2 bg-[var(--bg-tint)]">
          <div className="text-xs text-[var(--ink-secondary)] font-medium flex items-center gap-1.5"><Avatar name={selected.name} /> Configure {selected.name}</div>
          <p className="text-2xs text-[var(--ink-muted)]">The key is validated against {selected.name} before it is saved.</p>
          {selected.fields.map((f) => (
            <input
              key={f.key}
              type={f.secret ? 'password' : 'text'}
              placeholder={f.placeholder || f.label}
              value={fields[f.key] || ''}
              onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })}
              className={inputCls}
              aria-label={f.label}
            />
          ))}
          {error && <div className="text-xs text-[var(--danger)]">{error}</div>}
          <div className="flex gap-2">
            <button onClick={add} disabled={addBusy} className={btnPrimary}>
              {addBusy ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />} Connect
            </button>
            <button onClick={() => { setAddType(null); setError('') }} className={btnGhost}>Cancel</button>
          </div>
        </div>
      )}

      {/* Marketplace (collapsed, not shown by default) */}
      <div className="pt-1">
        <button
          onClick={() => setShowMarketplace((v) => !v)}
          className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] hover:bg-[var(--bg-hover)] transition text-left"
          aria-expanded={showMarketplace}
        >
          <span className="flex items-center gap-2 text-sm text-[var(--ink-primary)]"><Globe size={15} className="text-[var(--ink-muted)]" /> Marketplace <span className="text-2xs text-[var(--ink-muted)]">{data.marketplace.length} more integrations</span></span>
          <ChevronDown size={15} className={`text-[var(--ink-muted)] transition-transform ${showMarketplace ? 'rotate-180' : ''}`} />
        </button>
        {showMarketplace && (
          <div className="mt-2 space-y-2">
            <p className="text-2xs text-[var(--ink-muted)] leading-relaxed px-1">
              These connect with <strong className="text-[var(--ink-secondary)]">your own OAuth app</strong> — create an app at the provider&apos;s developer console, paste its client ID/secret, and sign in. The connection is real and the agent can call the provider&apos;s API.
            </p>
            {data.marketplace.map((m) => {
              const connected = configuredTypes.has(m.type)
              return (
                <div key={m.type} className="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <StatusDot state={connected ? 'ok' : 'idle'} />
                    <div className="min-w-0">
                      <div className="text-sm text-[var(--ink-primary)]">{m.name}</div>
                      <div className="text-2xs text-[var(--ink-muted)]">{connected ? 'connected' : 'bring your own OAuth app'}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {m.docs && (
                      <a href={m.docs} target="_blank" rel="noreferrer" className="p-1.5 rounded-lg text-[var(--ink-muted)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]" title={`${m.name} developer console`}><ExternalLink size={13} /></a>
                    )}
                    <button
                      onClick={() => { setMarketType(m); setClientCreds({ clientId: '', clientSecret: '' }); setError('') }}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-ui-xs bg-[var(--bg-hover)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover-strong)] transition"
                    >{connected ? 'Reconnect' : 'Add to my apps'}</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Marketplace OAuth-credential modal */}
      <Dialog
        open={marketType !== null}
        onClose={() => setMarketType(null)}
        ariaLabel={marketType ? `Connect ${marketType.name}` : undefined}
        size="md"
        zIndex="z-[60]"
        panelProps={{ 'data-settings-nested-dialog': 'true' }}
      >
        {marketType && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-ui-base font-semibold text-[var(--ink-primary)]">Connect {marketType.name}</h3>
              <button onClick={() => setMarketType(null)} className="p-1 rounded-lg text-[var(--ink-muted)] hover:text-[var(--ink-primary)]" aria-label="Close"><X size={15} /></button>
            </div>
            <p className="text-xs text-[var(--ink-muted)] leading-relaxed">
              Create an OAuth app in the {marketType.name} developer console
              {marketType.docs && <> (<a href={marketType.docs} target="_blank" rel="noreferrer" className="text-[var(--accent-text)] hover:underline">open console <ExternalLink size={10} className="inline" /></a>)</>}
              , add this redirect URL <code className="px-1 py-0.5 rounded bg-[var(--bg-code)] text-3xs text-[var(--ink-primary)]">{window.location.origin}/api/oauth-connector/callback</code>, then paste the app credentials.
            </p>
            <input placeholder="Client ID" value={clientCreds.clientId} onChange={(e) => setClientCreds({ ...clientCreds, clientId: e.target.value })} className={inputCls} aria-label="OAuth client ID" />
            <input placeholder="Client secret" type="password" value={clientCreds.clientSecret} onChange={(e) => setClientCreds({ ...clientCreds, clientSecret: e.target.value })} className={inputCls} aria-label="OAuth client secret" />
            {error && <div className="text-xs text-[var(--danger)]">{error}</div>}
            <div className="flex gap-2">
              <button
                onClick={() => startOAuth(marketType.type, clientCreds).then((started) => { if (started) setMarketType(null) })}
                disabled={oauthBusy === marketType.type || !clientCreds.clientId || !clientCreds.clientSecret}
                className={btnPrimary}
              >
                {oauthBusy === marketType.type ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Connect with my app
              </button>
              <button onClick={() => setMarketType(null)} className={btnGhost}>Cancel</button>
            </div>
          </div>
        )}
      </Dialog>

      {/* MCP servers are admin-only operator infrastructure (remote https). */}
      {mcpAdmin && (
      <div className="pt-1">
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] hover:bg-[var(--bg-hover)] transition text-left"
          aria-expanded={showAdvanced}
        >
          <span className="flex items-center gap-2 text-sm text-[var(--ink-primary)]"><Cable size={15} className="text-[var(--ink-muted)]" /> Advanced: MCP servers</span>
          <ChevronDown size={15} className={`text-[var(--ink-muted)] transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
        </button>
        {showAdvanced && <div className="mt-2"><McpSection /></div>}
      </div>
      )}
    </div>
  )
}

/** MCP server management (advanced section). */
function McpSection() {
  const [servers, setServers] = useState<any[]>([])
  const [form, setForm] = useState({ name: '', url: '' })
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const load = () => fetch(`${API_URL}/api/agent/mcp-servers`, { headers: authHeaders(), credentials: 'include' })
    .then(async (r) => {
      if (r.status === 403) throw new Error('admin')
      if (!r.ok) throw new Error('load')
      const d = await r.json()
      if (!Array.isArray(d)) throw new Error('load')
      setServers(d)
      setLoadError('')
    })
    .catch((e) => setLoadError(e?.message === 'admin' ? 'MCP servers are limited to administrators.' : 'Could not load MCP servers.'))
    .finally(() => setLoaded(true))
  useEffect(() => { load() }, [])
  const add = async () => {
    if (!form.name || !form.url) return
    setError('')
    if (!/^https:\/\//i.test(form.url.trim())) { setError('URL must be a public https address.'); return }
    const res = await fetch(`${API_URL}/api/agent/mcp-servers`, {
      method: 'POST', headers: authHeaders(), credentials: 'include',
      body: JSON.stringify({ name: form.name, transport: 'http', url: form.url.trim(), enabled: true }),
    }).catch(() => null)
    if (!res?.ok) {
      const body = res ? await res.json().catch(() => ({})) : {}
      setError(body.error || 'Could not save.')
      return
    }
    setForm({ name: '', url: '' }); load()
  }
  const remove = async (id: string) => { await fetch(`${API_URL}/api/agent/mcp-servers/${id}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {}); load() }
  return (
    <div className="space-y-2.5 text-sm">
      {loadError && (
        <div className="text-xs text-[var(--danger)] flex items-center gap-2 px-1">
          <span>{loadError}</span>
          <button type="button" onClick={() => load()} className="underline hover:text-[var(--danger)]">Retry</button>
        </div>
      )}
      {error && <div className="text-xs text-[var(--danger)] px-1">{error}</div>}
      {loaded && !loadError && servers.length === 0 && <p className="text-2xs text-[var(--ink-muted)] px-1">No MCP servers. Their tools become available to the agent once connected.</p>}
      {servers.map((s) => (
        <div key={s.id} className="p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-ui-sm text-[var(--ink-primary)]">{s.name} <span className="text-2xs text-[var(--ink-muted)]">({s.transport})</span></div>
            <div className="text-2xs text-[var(--ink-muted)] truncate">{s.url}</div>
            <div className={`text-2xs ${s.runtime?.status === 'connected' ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
              {s.runtime?.status === 'connected' ? `connected · ${s.runtime.tools.length} tools` : s.runtime?.error || 'not connected'}
            </div>
          </div>
          <button onClick={() => remove(s.id)} className="text-2xs text-[var(--ink-secondary)] hover:text-[var(--danger)] shrink-0 hover:underline">Remove</button>
        </div>
      ))}
      <div className="p-3.5 rounded-xl border border-dashed border-[var(--border-subtle)] space-y-2 bg-[var(--bg-tint)]">
        <div className="text-2xs uppercase tracking-widest text-[var(--ink-muted)]">Add server</div>
        <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} aria-label="Server name" />
        <input placeholder="https://server/mcp" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className={inputCls} aria-label="Server URL" />
        <button onClick={add} className={btnPrimary}><Plus size={14} /> Add server</button>
      </div>
    </div>
  )
}
