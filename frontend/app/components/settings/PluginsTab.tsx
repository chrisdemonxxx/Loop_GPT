'use client'

import { useEffect, useState } from 'react'
import { PackagePlus, Puzzle, Trash2 } from 'lucide-react'
import { API_URL, authHeaders } from '../../lib/api'
import { Badge, btnGhost, btnPrimary, EmptyState, inputCls, Toggle } from '../ui/primitives'

interface PluginItem {
  id: string
  name: string
  description: string
  enabled: boolean
  builtin?: boolean
  tools: string[]
}

/** Example manifest shown in the installer to make the format obvious. */
const EXAMPLE = `{
  "id": "my-api",
    "name": "My API",
    "description": "Tools for my service",
    "tools": [
      { "name": "get_items", "description": "List items", "method": "GET",
        "url": "https://api.example.com/items",
        "params": [{ "name": "limit", "type": "number", "description": "Max items" }] }
    ]
}`

/**
 * Plugins (brief §2.4): enable/disable built-ins and installed plugins, plus a
 * minimal install/uninstall lifecycle — data plugins are safe JSON manifests
 * of HTTP tools (never executed code).
 */
export default function PluginsTab() {
  const [items, setItems] = useState<PluginItem[]>([])
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [manifest, setManifest] = useState('')
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')

  const load = () =>
    fetch(`${API_URL}/api/agent/plugins`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => { setItems(Array.isArray(d) ? d : []); setLoading(false) })
      .catch(() => setLoading(false))
  useEffect(() => { load() }, [])

  const toggle = async (id: string, enabled: boolean) => {
    setItems((p) => p.map((i) => (i.id === id ? { ...i, enabled } : i)))
    await fetch(`${API_URL}/api/agent/plugins/${id}`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ enabled }) }).catch(() => {})
  }

  const install = async () => {
    setError(''); setOk('')
    try {
      const parsed = JSON.parse(manifest)
      const res = await fetch(`${API_URL}/api/agent/plugins/install`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify(parsed),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error || 'Install failed.'); return }
      setOk(`Installed "${d.name}" (${(d.tools || []).join(', ')}) and enabled it.`)
      setManifest(''); setInstalling(false); load()
    } catch (e: any) { setError(e?.message || 'Manifest is not valid JSON.') }
  }

  const uninstall = async (id: string) => {
    if (!confirm(`Uninstall plugin "${id}"? Its tools are removed.`)) return
    const res = await fetch(`${API_URL}/api/agent/plugins/${id}`, { method: 'DELETE', headers: authHeaders() }).catch(() => null)
    if (!res?.ok) { setError('Built-in or unknown plugin.'); return }
    setError(''); load()
  }

  if (loading) return <p className="text-slate-600 text-sm">Loading…</p>

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center justify-between">
        <p className="text-slate-500">Plugins bundle extra tools for the agent.</p>
        <button onClick={() => setInstalling((v) => !v)} className="flex items-center gap-1 text-xs text-[#e79d7f] hover:underline shrink-0">
          <PackagePlus size={13} /> Install from JSON
        </button>
      </div>

      {installing && (
        <div className="p-3.5 rounded-xl border border-dashed border-white/10 space-y-2 bg-white/[0.015]">
          <p className="text-[11px] text-slate-500 leading-relaxed">
            Paste a <strong className="text-slate-400">data-plugin manifest</strong> — HTTP tools only (GET/POST, {`{param}`} placeholders); the server never executes plugin code.
          </p>
          <textarea
            value={manifest}
            onChange={(e) => setManifest(e.target.value)}
            rows={8}
            spellCheck={false}
            placeholder={EXAMPLE}
            className="w-full bg-ink-800 border border-white/10 rounded-lg px-3 py-2.5 text-[12px] font-mono text-slate-200 focus:outline-none focus:accent-ring"
            aria-label="Plugin manifest JSON"
          />
          {error && <div className="text-xs text-rose-400">{error}</div>}
          {ok && <div className="text-xs text-emerald-400">{ok}</div>}
          <div className="flex gap-2">
            <button onClick={install} disabled={!manifest.trim()} className={btnPrimary}>Install plugin</button>
            <button onClick={() => { setInstalling(false); setError('') }} className={btnGhost}>Cancel</button>
          </div>
        </div>
      )}

      {items.length === 0 && (
        <EmptyState icon={<Puzzle size={22} />} title="No plugins installed" body="Plugins bundle extra tools. Install one from a JSON manifest, or enable a built-in." />
      )}

      <div className="space-y-2">
        {items.map((p) => (
          <div key={p.id} className="flex items-start justify-between gap-3 p-3.5 rounded-xl border border-white/[0.06] bg-white/[0.02]">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-100">{p.name}</span>
                {p.builtin ? <Badge>built-in</Badge> : <Badge tone="accent">installed</Badge>}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">{p.description}</div>
              {p.tools.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {p.tools.map((t) => <Badge key={t} tone="green">{t}</Badge>)}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!p.builtin && (
                <button
                  onClick={() => uninstall(p.id)}
                  title="Uninstall plugin"
                  aria-label={`Uninstall ${p.name}`}
                  className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-white/5 transition"
                ><Trash2 size={14} /></button>
              )}
              <Toggle on={p.enabled} onChange={(v) => toggle(p.id, v)} label={`Enable ${p.name}`} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
