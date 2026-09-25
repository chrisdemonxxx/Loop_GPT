'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Cable, Check, ChevronDown, ExternalLink, Globe, Loader2, Plug, Plus, RefreshCw, X,
} from 'lucide-react'
import { API_URL, authHeaders } from '../../lib/api'
import { Badge, btnGhost, btnPrimary, Card, EmptyState, inputCls, SearchInput, SectionHeader, StatusDot } from '../ui/primitives'

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

/** Letter avatar instead of emoji icons — consistent iconography. */
function Avatar({ name }: { name: string }) {
  return (
    <span className="w-7 h-7 rounded-lg bg-ink-800 border border-white/5 flex items-center justify-center text-[11px] font-semibold text-slate-300 shrink-0" aria-hidden>
      {name.slice(0, 2).toUpperCase()}
    </span>
  )
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
  const [showMarketplace, setShowMarketplace] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

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
      .then((r) => r.json()).then(setData).catch(() => {})
  useEffect(() => { load() }, [])

  const selected = data.types.find((t) => t.type === addType)

  const startOAuth = async (type: string, creds?: { clientId: string; clientSecret: string }) => {
    setError('')
    if (!workspaceId) { setError('Open a project first (Projects in the sidebar), then connect.'); return }
    setOauthBusy(type)
    try {
      const res = await fetch(`${API_URL}/api/oauth-connector/init/${type}`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ workspaceId, redirectTo: '/chat', ...(creds || {}) }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error || 'Could not start the sign-in flow.'); return }
      window.location.href = d.authorizeUrl
    } catch { setError('Could not start the sign-in flow.') } finally { setOauthBusy(null) }
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
      {/* Connected */}
      <SectionHeader title="Connected" count={data.configured.length} />
      {data.configured.length === 0 && (
        <p className="text-xs text-slate-600">Nothing connected yet — add an integration below.</p>
      )}
      {data.configured.map((c) => (
        <div key={c.id} className="p-3.5 rounded-xl border border-white/[0.06] bg-white/[0.02] flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <StatusDot state={c.lastTestOk === null ? 'idle' : c.lastTestOk ? 'ok' : 'error'} />
              <span className="text-sm font-medium text-slate-100">{c.name}</span>
              {c.account && <Badge>{c.account}</Badge>}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              {c.lastTestedAt ? `tested ${timeAgo(c.lastTestedAt)}` : 'not tested yet'}
              {testMsg[c.id] && <span className={c.lastTestOk ? ' text-emerald-400' : ' text-rose-400'}> · {testMsg[c.id]}</span>}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => test(c.id)}
              disabled={testing === c.id}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12px] bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition disabled:opacity-50"
              title="Test connection"
            ><RefreshCw size={12} className={testing === c.id ? 'animate-spin' : ''} /> Test</button>
            <button
              onClick={() => remove(c.id)}
              className="px-2.5 py-1.5 rounded-lg text-[12px] text-slate-400 hover:text-rose-400 hover:bg-white/5 transition"
            >Disconnect</button>
          </div>
        </div>
      ))}

      {/* Search */}
      <SearchInput value={query} onChange={setQuery} placeholder="Search connectors…" resultCount={q ? filtered.length : null} />
      {error && <div className="text-xs text-rose-400">{error}</div>}

      {/* Available by category */}
      {categories.map(([cat, types]) => (
        <div key={cat} className="space-y-2">
          <SectionHeader title={cat} count={types.length} />
          <div className="grid grid-cols-2 gap-2">
            {types.map((t) => {
              const connected = configuredTypes.has(t.type)
              return (
                <Card
                  key={t.type}
                  title={<span className="flex items-center gap-2"><Avatar name={t.name} />{t.name}</span>}
                  description={t.description}
                  badge={connected ? <Badge tone="green">connected</Badge> : undefined}
                  onClick={t.oauth ? undefined : () => { setAddType(t.type); setFields({}); setError('') }}
                  actions={t.oauth ? (
                    OAUTH_LABEL[t.type] ? (
                      <button
                        onClick={() => startOAuth(t.type)}
                        disabled={oauthBusy === t.type}
                        className="flex items-center gap-1 text-xs text-[#e79d7f] hover:underline self-start disabled:opacity-50"
                      >
                        {oauthBusy === t.type ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Connect with {OAUTH_LABEL[t.type]}
                      </button>
                    ) : null
                  ) : (
                    <button className="flex items-center gap-1 text-xs text-[#e79d7f] hover:underline self-start"><Plus size={12} /> Add</button>
                  )}
                />
              )
            })}
          </div>
        </div>
      ))}
      {q && filtered.length === 0 && <p className="text-center text-xs text-slate-600 py-3">No connectors match “{query}”.</p>}

      {/* Credential modal */}
      {selected && !selected.oauth && (
        <div className="p-3.5 rounded-xl border border-dashed border-white/10 space-y-2 bg-white/[0.015]">
          <div className="text-xs text-slate-300 font-medium flex items-center gap-1.5"><Avatar name={selected.name} /> Configure {selected.name}</div>
          <p className="text-[11px] text-slate-500">The key is validated against {selected.name} before it is saved.</p>
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
          {error && <div className="text-xs text-rose-400">{error}</div>}
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
          className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.035] transition text-left"
          aria-expanded={showMarketplace}
        >
          <span className="flex items-center gap-2 text-sm text-slate-200"><Globe size={15} className="text-slate-500" /> Marketplace <span className="text-[11px] text-slate-600">{data.marketplace.length} more integrations</span></span>
          <ChevronDown size={15} className={`text-slate-500 transition-transform ${showMarketplace ? 'rotate-180' : ''}`} />
        </button>
        {showMarketplace && (
          <div className="mt-2 space-y-2">
            <p className="text-[11px] text-slate-500 leading-relaxed px-1">
              These connect with <strong className="text-slate-400">your own OAuth app</strong> — create an app at the provider&apos;s developer console, paste its client ID/secret, and sign in. The connection is real and the agent can call the provider&apos;s API.
            </p>
            {data.marketplace.map((m) => {
              const connected = configuredTypes.has(m.type)
              return (
                <div key={m.type} className="p-3.5 rounded-xl border border-white/[0.06] bg-white/[0.02] flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <StatusDot state={connected ? 'ok' : 'idle'} />
                    <div className="min-w-0">
                      <div className="text-sm text-slate-200">{m.name}</div>
                      <div className="text-[11px] text-slate-500">{connected ? 'connected' : 'bring your own OAuth app'}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {m.docs && (
                      <a href={m.docs} target="_blank" rel="noreferrer" className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/5" title={`${m.name} developer console`}><ExternalLink size={13} /></a>
                    )}
                    <button
                      onClick={() => { setMarketType(m); setClientCreds({ clientId: '', clientSecret: '' }); setError('') }}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12px] bg-white/[0.04] text-slate-200 hover:bg-white/[0.08] transition"
                    >{connected ? 'Reconnect' : 'Add to my apps'}</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Marketplace OAuth-credential modal */}
      {marketType && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setMarketType(null)}>
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#1c1c1f] p-5 space-y-3 shadow-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Connect ${marketType.name}`}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">Connect {marketType.name}</h3>
              <button onClick={() => setMarketType(null)} className="p-1 rounded-lg text-slate-500 hover:text-slate-200" aria-label="Close"><X size={15} /></button>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              Create an OAuth app in the {marketType.name} developer console
              {marketType.docs && <> (<a href={marketType.docs} target="_blank" rel="noreferrer" className="text-[#e79d7f] hover:underline">open console <ExternalLink size={10} className="inline" /></a>)</>}
              , add this redirect URL <code className="px-1 py-0.5 rounded bg-white/5 text-[10px]">{window.location.origin}/api/oauth-connector/callback</code>, then paste the app credentials.
            </p>
            <input placeholder="Client ID" value={clientCreds.clientId} onChange={(e) => setClientCreds({ ...clientCreds, clientId: e.target.value })} className={inputCls} aria-label="OAuth client ID" />
            <input placeholder="Client secret" type="password" value={clientCreds.clientSecret} onChange={(e) => setClientCreds({ ...clientCreds, clientSecret: e.target.value })} className={inputCls} aria-label="OAuth client secret" />
            {error && <div className="text-xs text-rose-400">{error}</div>}
            <div className="flex gap-2">
              <button
                onClick={() => startOAuth(marketType.type, clientCreds).then(() => { if (!error) setMarketType(null) })}
                disabled={oauthBusy === marketType.type || !clientCreds.clientId || !clientCreds.clientSecret}
                className={btnPrimary}
              >
                {oauthBusy === marketType.type ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Connect with my app
              </button>
              <button onClick={() => setMarketType(null)} className={btnGhost}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Advanced: MCP servers */}
      <div className="pt-1">
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.035] transition text-left"
          aria-expanded={showAdvanced}
        >
          <span className="flex items-center gap-2 text-sm text-slate-200"><Cable size={15} className="text-slate-500" /> Advanced: MCP servers</span>
          <ChevronDown size={15} className={`text-slate-500 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
        </button>
        {showAdvanced && <div className="mt-2"><McpSection /></div>}
      </div>
    </div>
  )
}

/** MCP server management (advanced section). */
function McpSection() {
  const [servers, setServers] = useState<any[]>([])
  const [form, setForm] = useState({ name: '', transport: 'http', url: '', command: '' })
  const load = () => fetch(`${API_URL}/api/agent/mcp-servers`, { headers: authHeaders() }).then((r) => r.json()).then(setServers).catch(() => {})
  useEffect(() => { load() }, [])
  const add = async () => {
    if (!form.name) return
    await fetch(`${API_URL}/api/agent/mcp-servers`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ name: form.name, transport: form.transport, url: form.url || undefined, command: form.command || undefined, enabled: true }),
    }).catch(() => {})
    setForm({ name: '', transport: 'http', url: '', command: '' }); load()
  }
  const remove = async (id: string) => { await fetch(`${API_URL}/api/agent/mcp-servers/${id}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {}); load() }
  return (
    <div className="space-y-2.5 text-sm">
      {servers.length === 0 && <p className="text-[11px] text-slate-600 px-1">No MCP servers. Their tools become available to the agent once connected.</p>}
      {servers.map((s) => (
        <div key={s.id} className="p-3 rounded-xl border border-white/[0.06] bg-white/[0.02] flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] text-slate-200">{s.name} <span className="text-[11px] text-slate-500">({s.transport})</span></div>
            <div className="text-[11px] text-slate-500 truncate">{s.url || s.command}</div>
            <div className={`text-[11px] ${s.runtime?.status === 'connected' ? 'text-emerald-400' : 'text-rose-400'}`}>
              {s.runtime?.status === 'connected' ? `connected · ${s.runtime.tools.length} tools` : s.runtime?.error || 'not connected'}
            </div>
          </div>
          <button onClick={() => remove(s.id)} className="text-[11px] text-slate-400 hover:text-rose-400 shrink-0 hover:underline">Remove</button>
        </div>
      ))}
      <div className="p-3.5 rounded-xl border border-dashed border-white/10 space-y-2 bg-white/[0.015]">
        <div className="text-[11px] uppercase tracking-widest text-slate-500">Add server</div>
        <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} aria-label="Server name" />
        <select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value })} className={inputCls} aria-label="Transport">
          <option value="http" className="bg-ink-800">HTTP (Streamable)</option>
          <option value="stdio" className="bg-ink-800">stdio (local command)</option>
        </select>
        {form.transport === 'http'
          ? <input placeholder="https://server/mcp" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className={inputCls} aria-label="Server URL" />
          : <input placeholder="npx -y @modelcontextprotocol/server-filesystem" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} className={inputCls} aria-label="Command" />}
        <button onClick={add} className={btnPrimary}><Plus size={14} /> Add server</button>
      </div>
    </div>
  )
}
