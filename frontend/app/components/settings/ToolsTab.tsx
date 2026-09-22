'use client'

import { useEffect, useState } from 'react'
import { Wrench } from 'lucide-react'
import { API_URL, authHeaders } from '../../lib/api'

interface ToolRow { name: string; description: string; source: string; default: string; effective: string }
interface AuditRow { at: string; tool: string; args: string; outcome: string; ms: number }

const label: Record<string, string> = { allow: 'Always allow', approval: 'Needs approval', blocked: 'Blocked' }

/**
 * Tools: per-tool permission levels (allow / needs approval / blocked) plus a
 * bounded audit log of recent tool calls.
 */
export default function ToolsTab() {
  const [data, setData] = useState<{ tools: ToolRow[]; permissions: Record<string, string> }>({ tools: [], permissions: {} })
  const [audit, setAudit] = useState<AuditRow[]>([])
  const [showAudit, setShowAudit] = useState(false)
  const load = () => fetch(`${API_URL}/api/agent/permissions`, { headers: authHeaders() }).then((r) => r.json()).then(setData).catch(() => {})
  useEffect(() => { load() }, [])
  const setLevel = async (name: string, level: string) => {
    setData((d) => ({ ...d, permissions: { ...d.permissions, [name]: level } }))
    await fetch(`${API_URL}/api/agent/permissions`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ name, level }) }).catch(() => {})
  }
  const loadAudit = async () => {
    setShowAudit((v) => !v)
    const rows = await fetch(`${API_URL}/api/agent/audit?limit=100`, { headers: authHeaders() }).then((r) => r.json()).catch(() => [])
    setAudit(rows)
  }

  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center justify-between mb-1">
        <p className="text-slate-500 flex items-center gap-1.5"><Wrench size={13} /> {data.tools.length} tools. Set what the agent may run on its own.</p>
        <button onClick={loadAudit} className="text-xs text-[#e79d7f] hover:underline">{showAudit ? 'Hide' : 'View'} audit log</button>
      </div>
      {showAudit && (
        <div className="mb-2 rounded-xl border border-white/[0.06] bg-white/[0.02] max-h-48 overflow-y-auto divide-y divide-white/5">
          {audit.length === 0 && <div className="p-3 text-xs text-slate-500">No tool calls recorded yet.</div>}
          {audit.map((a, i) => (
            <div key={i} className="p-2 text-[11px] flex items-center gap-2">
              <span className={`px-1.5 py-0.5 rounded ${a.outcome === 'ok' ? 'bg-emerald-500/10 text-emerald-400' : a.outcome === 'blocked' || a.outcome === 'denied' ? 'bg-rose-500/10 text-rose-400' : 'bg-white/5 text-slate-400'}`}>{a.outcome}</span>
              <span className="font-mono text-slate-300">{a.tool}</span>
              <span className="text-slate-600 truncate flex-1">{a.args}</span>
              <span className="text-slate-600">{a.ms}ms</span>
            </div>
          ))}
        </div>
      )}
      {data.tools.map((t) => {
        const effective = data.permissions[t.name] || t.default
        return (
          <div key={t.name} className="flex items-start justify-between gap-3 p-3 rounded-xl border border-white/[0.06] bg-white/[0.02]">
            <div className="min-w-0">
              <div className="font-mono text-xs text-slate-200">{t.name} <span className="text-slate-600">· {t.source}</span></div>
              <div className="text-xs text-slate-500 mt-0.5">{t.description}</div>
            </div>
            <select
              value={effective}
              onChange={(e) => setLevel(t.name, e.target.value)}
              className="shrink-0 bg-ink-800 border border-white/10 rounded-lg px-2 py-1 text-xs text-slate-200 focus:outline-none"
              aria-label={`Permission for ${t.name}`}
            >
              {['allow', 'approval', 'blocked'].map((l) => <option key={l} value={l} className="bg-ink-800">{label[l]}</option>)}
            </select>
          </div>
        )
      })}
    </div>
  )
}
