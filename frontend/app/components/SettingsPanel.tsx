'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { X, Wrench, Puzzle, Blocks, Cable, Sparkles, Plug, Plus, Trash2, Hammer } from 'lucide-react'
import { API_URL, authHeaders, getProviderSettings } from '../lib/api'

interface Props { onClose: () => void; initialTab?: string }
type Tab = 'model' | 'skills' | 'plugins' | 'builder' | 'mcp' | 'connectors' | 'tools'

const inputCls = 'mt-1 w-full bg-ink-800 border border-white/10 rounded-lg px-3 py-2 text-slate-100 text-sm focus:outline-none focus:accent-ring placeholder-slate-600'
const btnCls = 'px-3 py-1.5 rounded-lg text-sm text-white bg-[#c96442] hover:bg-[#b5593a] transition'

export default function SettingsPanel({ onClose, initialTab }: Props) {
  const TABS: Tab[] = ['model', 'skills', 'plugins', 'builder', 'connectors', 'mcp', 'tools']
  const [tab, setTab] = useState<Tab>((TABS.includes(initialTab as Tab) ? initialTab : 'model') as Tab)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <motion.div initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }}
        className="glass-strong rounded-2xl w-full max-w-2xl max-h-[86vh] flex flex-col overflow-hidden shadow-panel" onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 flex items-center justify-between px-5 py-4 border-b border-white/5">
          <h2 className="text-lg font-semibold text-gradient">Agent settings</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-white/10 rounded-lg text-slate-400"><X size={18} /></button>
        </div>
        <div className="shrink-0 flex border-b border-white/5 text-sm overflow-x-auto no-scrollbar">
          {([['model', 'Model', Sparkles], ['skills', 'Skills', Blocks], ['plugins', 'Plugins', Puzzle], ['builder', 'Builder', Hammer], ['connectors', 'Connectors', Plug], ['mcp', 'MCP', Cable], ['tools', 'Tools', Wrench]] as [Tab, string, any][]).map(([id, label, Icon]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`shrink-0 flex items-center gap-1.5 px-4 py-2.5 whitespace-nowrap border-b-2 transition ${tab === id ? 'border-neon-violet text-neon-violet' : 'border-transparent text-slate-500 hover:text-slate-200'}`}>
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'model' && <ModelTab />}
          {tab === 'skills' && <SkillsTab />}
          {tab === 'plugins' && <ToggleList endpoint="plugins" emptyLabel="No plugins found." />}
          {tab === 'builder' && <BuilderTab />}
          {tab === 'mcp' && <McpTab />}
          {tab === 'connectors' && <ConnectorMarketplace />}
          {tab === 'tools' && <ToolsTab />}
        </div>
      </motion.div>
    </div>
  )
}

function ModelTab() {
  const [s, setS] = useState(getProviderSettings())
  const save = (patch: Partial<typeof s>) => {
    const next = { ...s, ...patch }; setS(next)
    localStorage.setItem('aiProvider', next.provider); localStorage.setItem('aiModel', next.model); localStorage.setItem('aiApiKey', next.apiKey)
  }
  return (
    <div className="space-y-4 text-sm">
      <p className="text-slate-500">Default backend is your Hugging Face Inference Endpoint (server-side <code className="mx-1 px-1 bg-white/5 rounded text-slate-300">HF_ENDPOINT_URL</code>/<code className="px-1 bg-white/5 rounded text-slate-300">HF_TOKEN</code>). Override only to use a different model.</p>
      <label className="block"><span className="text-slate-300 font-medium">Provider</span>
        <select value={s.provider} onChange={(e) => save({ provider: e.target.value })} className={inputCls}>
          {['huggingface', 'openai', 'anthropic', 'groq', 'together', 'nvidia', 'xai', 'perplexity', 'ollama', 'local'].map((p) => <option key={p} value={p} className="bg-ink-800">{p}</option>)}
        </select>
      </label>
      <label className="block"><span className="text-slate-300 font-medium">Model (optional)</span>
        <input value={s.model} onChange={(e) => save({ model: e.target.value })} placeholder="leave blank for endpoint default" className={inputCls} />
      </label>
      <label className="block"><span className="text-slate-300 font-medium">API key override (optional)</span>
        <input type="password" value={s.apiKey} onChange={(e) => save({ apiKey: e.target.value })} placeholder="stored in your browser only" className={inputCls} />
      </label>
    </div>
  )
}

interface SkillItem { id: string; name: string; description: string; enabled: boolean; builtin?: boolean }
function SkillsTab() {
  const [items, setItems] = useState<SkillItem[]>([])
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: '', description: '', triggers: '', tools: '', instructions: '' })
  const load = () => fetch(`${API_URL}/api/agent/skills`, { headers: authHeaders() }).then((r) => r.json()).then(setItems).catch(() => {})
  useEffect(() => { load() }, [])
  const toggle = async (id: string, enabled: boolean) => {
    setItems((p) => p.map((i) => (i.id === id ? { ...i, enabled } : i)))
    await fetch(`${API_URL}/api/agent/skills/${id}`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ enabled }) })
  }
  const remove = async (id: string) => { await fetch(`${API_URL}/api/agent/skills/${id}`, { method: 'DELETE', headers: authHeaders() }); load() }
  const create = async () => {
    if (!form.name || !form.instructions) return
    await fetch(`${API_URL}/api/agent/skills`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(form) })
    setForm({ name: '', description: '', triggers: '', tools: '', instructions: '' }); setCreating(false); load()
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-slate-500 text-sm">Skills inject expert instructions when relevant. Toggle or create your own.</p>
        <button onClick={() => setCreating((v) => !v)} className="flex items-center gap-1 text-xs text-neon-violet hover:underline"><Plus size={13} /> Create skill</button>
      </div>
      {creating && (
        <div className="p-3 rounded-lg border border-dashed border-white/10 space-y-2 bg-white/2">
          <input placeholder="Skill name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
          <input placeholder="Short description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputCls} />
          <input placeholder="Trigger keywords (comma-separated, optional)" value={form.triggers} onChange={(e) => setForm({ ...form, triggers: e.target.value })} className={inputCls} />
          <input placeholder="Recommended tools (comma-separated, e.g. web_search, create_document)" value={form.tools} onChange={(e) => setForm({ ...form, tools: e.target.value })} className={inputCls} />
          <textarea placeholder="Instructions the agent should follow when this skill is active…" rows={4} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} className={inputCls} />
          <div className="flex gap-2"><button onClick={create} className={btnCls}>Save skill</button><button onClick={() => setCreating(false)} className="px-3 py-1.5 rounded-lg text-sm text-slate-400 hover:bg-white/5">Cancel</button></div>
        </div>
      )}
      <div className="space-y-2">
        {items.map((i) => (
          <div key={i.id} className="flex items-start justify-between gap-3 p-3 rounded-lg glass">
            <div className="min-w-0">
              <div className="font-medium text-sm text-slate-200 flex items-center gap-2">{i.name}{i.builtin && <span className="text-[10px] px-1.5 py-0.5 bg-white/5 rounded text-slate-500">built-in</span>}</div>
              <div className="text-xs text-slate-500">{i.description}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!i.builtin && <button onClick={() => remove(i.id)} className="text-slate-500 hover:text-rose-400"><Trash2 size={14} /></button>}
              <button onClick={() => toggle(i.id, !i.enabled)} className={`w-11 h-6 rounded-full transition ${i.enabled ? 'bg-gradient-to-r from-neon-violet to-neon-indigo shadow-glow' : 'bg-white/10'}`}>
                <span className={`block w-5 h-5 bg-white rounded-full transition-transform ${i.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

interface ToggleItem { id: string; name: string; description: string; enabled: boolean; builtin?: boolean }
function ToggleList({ endpoint, emptyLabel }: { endpoint: string; emptyLabel: string }) {
  const [items, setItems] = useState<ToggleItem[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { fetch(`${API_URL}/api/agent/${endpoint}`, { headers: authHeaders() }).then((r) => r.json()).then((d) => { setItems(d); setLoading(false) }).catch(() => setLoading(false)) }, [endpoint])
  const toggle = async (id: string, enabled: boolean) => {
    setItems((p) => p.map((i) => (i.id === id ? { ...i, enabled } : i)))
    await fetch(`${API_URL}/api/agent/${endpoint}/${id}`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ enabled }) })
  }
  if (loading) return <p className="text-slate-600 text-sm">Loading…</p>
  if (!items.length) return <p className="text-slate-600 text-sm">{emptyLabel}</p>
  return (
    <div className="space-y-2">
      {items.map((i) => (
        <div key={i.id} className="flex items-start justify-between gap-3 p-3 rounded-lg glass">
          <div><div className="font-medium text-sm text-slate-200">{i.name}</div><div className="text-xs text-slate-500">{i.description}</div></div>
          <button onClick={() => toggle(i.id, !i.enabled)} className={`shrink-0 w-11 h-6 rounded-full transition ${i.enabled ? 'bg-gradient-to-r from-neon-violet to-neon-indigo shadow-glow' : 'bg-white/10'}`}>
            <span className={`block w-5 h-5 bg-white rounded-full transition-transform ${i.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
      ))}
    </div>
  )
}

interface Param { name: string; type: string; required: boolean; description: string }
function BuilderTab() {
  const [tools, setTools] = useState<any[]>([])
  const [form, setForm] = useState({ name: '', description: '', method: 'GET', url: '' })
  const [params, setParams] = useState<Param[]>([{ name: '', type: 'string', required: true, description: '' }])
  const load = () => fetch(`${API_URL}/api/agent/custom-tools`, { headers: authHeaders() }).then((r) => r.json()).then(setTools).catch(() => {})
  useEffect(() => { load() }, [])
  const create = async () => {
    if (!form.name || !form.url) return
    const cleanParams = params.filter((p) => p.name.trim())
    await fetch(`${API_URL}/api/agent/custom-tools`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ ...form, params: cleanParams }) })
    setForm({ name: '', description: '', method: 'GET', url: '' }); setParams([{ name: '', type: 'string', required: true, description: '' }]); load()
  }
  const remove = async (id: string) => { await fetch(`${API_URL}/api/agent/custom-tools/${id}`, { method: 'DELETE', headers: authHeaders() }); load() }
  return (
    <div className="space-y-3 text-sm">
      <p className="text-slate-500">Build a custom tool that calls any HTTP endpoint — no code required. Use <code className="px-1 bg-white/5 rounded text-slate-300">{'{param}'}</code> placeholders in the URL; other params become the query string (GET) or JSON body (POST).</p>
      {tools.map((t) => (
        <div key={t.id} className="flex items-center justify-between p-3 rounded-lg glass">
          <div><div className="font-mono text-xs text-neon-cyan">{t.name}</div><div className="text-xs text-slate-500">{t.method} {t.url}</div></div>
          <button onClick={() => remove(t.id)} className="text-slate-500 hover:text-rose-400"><Trash2 size={14} /></button>
        </div>
      ))}
      <div className="p-3 rounded-lg border border-dashed border-white/10 space-y-2">
        <div className="text-xs text-slate-400 font-medium">New tool</div>
        <input placeholder="tool_name (identifier)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
        <input placeholder="What the tool does (the agent reads this)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputCls} />
        <div className="flex gap-2">
          <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} className={inputCls + ' w-28'}>
            <option value="GET" className="bg-ink-800">GET</option><option value="POST" className="bg-ink-800">POST</option>
          </select>
          <input placeholder="https://api.example.com/search?q={query}" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className={inputCls} />
        </div>
        <div className="text-xs text-slate-500 pt-1">Parameters</div>
        {params.map((p, idx) => (
          <div key={idx} className="flex gap-2 items-center">
            <input placeholder="name" value={p.name} onChange={(e) => setParams(params.map((x, i) => i === idx ? { ...x, name: e.target.value } : x))} className={inputCls + ' flex-1'} />
            <select value={p.type} onChange={(e) => setParams(params.map((x, i) => i === idx ? { ...x, type: e.target.value } : x))} className={inputCls + ' w-24'}>
              <option value="string" className="bg-ink-800">string</option><option value="number" className="bg-ink-800">number</option><option value="boolean" className="bg-ink-800">boolean</option>
            </select>
            <label className="flex items-center gap-1 text-xs text-slate-400"><input type="checkbox" checked={p.required} onChange={(e) => setParams(params.map((x, i) => i === idx ? { ...x, required: e.target.checked } : x))} /> req</label>
            <button onClick={() => setParams(params.filter((_, i) => i !== idx))} className="text-slate-600 hover:text-rose-400"><X size={14} /></button>
          </div>
        ))}
        <button onClick={() => setParams([...params, { name: '', type: 'string', required: false, description: '' }])} className="text-xs text-neon-cyan hover:underline flex items-center gap-1"><Plus size={12} /> add parameter</button>
        <div><button onClick={create} className={btnCls}>Create tool</button></div>
      </div>
    </div>
  )
}

function McpTab() {
  const [servers, setServers] = useState<any[]>([])
  const [form, setForm] = useState({ name: '', transport: 'http', url: '', command: '' })
  const load = () => fetch(`${API_URL}/api/agent/mcp-servers`, { headers: authHeaders() }).then((r) => r.json()).then(setServers).catch(() => {})
  useEffect(() => { load() }, [])
  const add = async () => {
    if (!form.name) return
    await fetch(`${API_URL}/api/agent/mcp-servers`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ name: form.name, transport: form.transport, url: form.url || undefined, command: form.command || undefined, enabled: true }) })
    setForm({ name: '', transport: 'http', url: '', command: '' }); load()
  }
  const remove = async (id: string) => { await fetch(`${API_URL}/api/agent/mcp-servers/${id}`, { method: 'DELETE', headers: authHeaders() }); load() }
  return (
    <div className="space-y-4 text-sm">
      <p className="text-slate-500">Connect Model Context Protocol servers. Their tools become available to the agent.</p>
      {servers.map((s) => (
        <div key={s.id} className="flex items-center justify-between p-3 rounded-lg glass">
          <div>
            <div className="font-medium text-slate-200">{s.name} <span className="text-xs text-slate-500">({s.transport})</span></div>
            <div className="text-xs text-slate-500">{s.url || s.command}</div>
            <div className={`text-xs ${s.runtime?.status === 'connected' ? 'text-neon-green' : 'text-rose-400'}`}>{s.runtime?.status === 'connected' ? `connected · ${s.runtime.tools.length} tools` : s.runtime?.error || 'not connected'}</div>
          </div>
          <button onClick={() => remove(s.id)} className="text-rose-400 text-xs hover:underline">Remove</button>
        </div>
      ))}
      <div className="p-3 rounded-lg border border-dashed border-white/10 space-y-2">
        <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
        <select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value })} className={inputCls}>
          <option value="http" className="bg-ink-800">HTTP (Streamable)</option><option value="stdio" className="bg-ink-800">stdio (local command)</option>
        </select>
        {form.transport === 'http'
          ? <input placeholder="https://server/mcp" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className={inputCls} />
          : <input placeholder="npx -y @modelcontextprotocol/server-filesystem" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} className={inputCls} />}
        <button onClick={add} className={btnCls}>Add server</button>
      </div>
    </div>
  )
}

function ConnectorMarketplace() {
  const [data, setData] = useState<{ types: any[]; configured: any[] }>({ types: [], configured: [] })
  const [addType, setAddType] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const load = () => fetch(`${API_URL}/api/agent/connectors`, { headers: authHeaders() }).then((r) => r.json()).then(setData).catch(() => {})
  useEffect(() => { load() }, [])
  const selected = data.types.find((t) => t.type === addType)
  const add = async () => {
    if (!selected) return
    setError('')
    const res = await fetch(`${API_URL}/api/agent/connectors`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ type: addType, name: selected.name, config: fields, enabled: true }) })
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Could not connect.'); return }
    setFields({}); setAddType(null); load()
  }
  const remove = async (id: string) => { await fetch(`${API_URL}/api/agent/connectors/${id}`, { method: 'DELETE', headers: authHeaders() }); load() }

  const configuredTypes = new Set(data.configured.map((c) => c.type))
  const q = query.trim().toLowerCase()
  const filtered = data.types.filter((t) => !q || t.name.toLowerCase().includes(q) || (t.category || '').toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q))
  const categories = Array.from(new Set(filtered.map((t) => t.category || 'Other')))

  return (
    <div className="space-y-4 text-sm">
      <p className="text-slate-500">Connect your apps — {data.types.length} integrations. Secrets are stored server-side and never returned.</p>

      {data.configured.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-slate-500">Connected</div>
          {data.configured.map((c) => (
            <div key={c.id} className="flex items-center justify-between p-3 rounded-lg glass">
              <div className="font-medium text-slate-200 flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-neon-green" />{c.name} <span className="text-xs text-slate-500">({c.type})</span></div>
              <button onClick={() => remove(c.id)} className="text-rose-400 text-xs hover:underline">Remove</button>
            </div>
          ))}
        </div>
      )}

      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search connectors…" className={inputCls} />

      {categories.map((cat) => (
        <div key={cat} className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-slate-500">{cat}</div>
          <div className="grid grid-cols-2 gap-2">
            {filtered.filter((t) => (t.category || 'Other') === cat).map((t) => (
              <div key={t.type} className="p-3 rounded-xl glass hover:accent-ring transition flex flex-col">
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-7 h-7 rounded-lg bg-ink-800 border border-white/5 flex items-center justify-center text-base">{t.icon || '🔌'}</div>
                  <span className="font-medium text-slate-200 truncate">{t.name}</span>
                  {configuredTypes.has(t.type) && <span className="ml-auto text-[10px] text-neon-green">●</span>}
                </div>
                <p className="text-xs text-slate-500 flex-1">{t.description}</p>
                {t.oauth ? (
                  <span className="mt-2 text-[10px] text-amber-400/80 bg-amber-500/10 rounded px-1.5 py-0.5 self-start">OAuth setup required</span>
                ) : (
                  <button onClick={() => { setAddType(t.type); setFields({}); setError('') }} className="mt-2 text-xs text-neon-violet hover:underline self-start flex items-center gap-1"><Plus size={12} /> Add</button>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {selected && !selected.oauth && (
        <div className="p-3 rounded-lg border border-dashed border-white/10 space-y-2">
          <div className="text-xs text-slate-400 font-medium flex items-center gap-1.5"><span>{selected.icon || '🔌'}</span> Configure {selected.name}</div>
          {selected.fields?.map((f: any) => (
            <input key={f.key} type={f.secret ? 'password' : 'text'} placeholder={f.placeholder || f.label} value={fields[f.key] || ''} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} className={inputCls} />
          ))}
          {error && <div className="text-xs text-rose-400">{error}</div>}
          <div className="flex gap-2"><button onClick={add} className={btnCls}>Connect</button><button onClick={() => setAddType(null)} className="px-3 py-1.5 rounded-lg text-sm text-slate-400 hover:bg-white/5">Cancel</button></div>
        </div>
      )}
    </div>
  )
}

function ToolsTab() {
  const [tools, setTools] = useState<any[]>([])
  useEffect(() => { fetch(`${API_URL}/api/agent/tools`, { headers: authHeaders() }).then((r) => r.json()).then(setTools).catch(() => {}) }, [])
  return (
    <div className="space-y-1.5 text-sm">
      <p className="text-slate-500 mb-2">{tools.length} tools available to the agent.</p>
      {tools.map((t) => (
        <div key={t.name} className="p-2.5 rounded-lg glass">
          <div className="font-mono text-xs text-neon-cyan">{t.name} <span className="text-slate-600">· {t.source}</span></div>
          <div className="text-xs text-slate-500">{t.description}</div>
        </div>
      ))}
    </div>
  )
}
