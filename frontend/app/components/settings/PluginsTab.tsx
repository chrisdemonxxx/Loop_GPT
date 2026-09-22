'use client'

import { useEffect, useState } from 'react'
import { Puzzle } from 'lucide-react'
import { API_URL, authHeaders } from '../../lib/api'
import { EmptyState, Toggle } from '../ui/primitives'

interface ToggleItem { id: string; name: string; description: string; enabled: boolean; builtin?: boolean }

/** Plugins: enable/disable installed plugin bundles. */
export default function PluginsTab() {
  const [items, setItems] = useState<ToggleItem[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    fetch(`${API_URL}/api/agent/plugins`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => { setItems(Array.isArray(d) ? d : []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])
  const toggle = async (id: string, enabled: boolean) => {
    setItems((p) => p.map((i) => (i.id === id ? { ...i, enabled } : i)))
    await fetch(`${API_URL}/api/agent/plugins/${id}`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ enabled }) }).catch(() => {})
  }
  if (loading) return <p className="text-slate-600 text-sm">Loading…</p>
  if (!items.length) return <EmptyState icon={<Puzzle size={22} />} title="No plugins installed" body="Plugins bundle extra tools. Install one to extend what the agent can do." />
  return (
    <div className="space-y-2 text-sm">
      {items.map((i) => (
        <div key={i.id} className="flex items-start justify-between gap-3 p-3.5 rounded-xl border border-white/[0.06] bg-white/[0.02]">
          <div className="min-w-0">
            <div className="text-sm font-medium text-slate-100">{i.name}</div>
            <div className="text-xs text-slate-500 mt-0.5">{i.description}</div>
          </div>
          <Toggle on={i.enabled} onChange={(v) => toggle(i.id, v)} label={`Enable ${i.name}`} />
        </div>
      ))}
    </div>
  )
}
