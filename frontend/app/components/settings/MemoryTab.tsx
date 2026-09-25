'use client'

import { useEffect, useMemo, useState } from 'react'
import { Brain, Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { API_URL, authHeaders } from '../../lib/api'
import { Badge, btnGhost, btnPrimary, Card, EmptyState, inputCls, SearchInput, SectionHeader, Toggle } from '../ui/primitives'

interface MemoryRow {
  id: string
  content: string
  kind: string
  source?: string
  tags: string[]
  createdAt: string
  updatedAt: string
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/**
 * Memory settings (Claude-style): master toggle, search, per-item edit/delete,
 * user-vs-learned source badges, tag grouping, and a real empty state.
 */
export default function MemoryTab() {
  const [rows, setRows] = useState<MemoryRow[]>([])
  const [enabled, setEnabled] = useState(true)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')

  const load = () =>
    fetch(`${API_URL}/api/memory`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((d: { memories?: MemoryRow[]; enabled?: boolean } | MemoryRow[]) => {
        if (Array.isArray(d)) setRows(d)
        else { setRows(d.memories || []); setEnabled(d.enabled !== false) }
      })
      .catch(() => {})
  useEffect(() => { load() }, [])

  const toggleEnabled = async (next: boolean) => {
    setEnabled(next)
    await fetch(`${API_URL}/api/memory/enabled`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ enabled: next }) }).catch(() => {})
  }

  const add = async () => {
    if (!text.trim()) return
    setError('')
    const res = await fetch(`${API_URL}/api/memory`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ content: text.trim() }) })
    if (!res.ok) { setError((await res.json().catch(() => ({}))).error || 'Could not save.'); return }
    setText(''); load()
  }

  const saveEdit = async () => {
    if (!editingId || !editText.trim()) { setEditingId(null); return }
    await fetch(`${API_URL}/api/memory/${editingId}`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ content: editText.trim() }) }).catch(() => {})
    setEditingId(null); load()
  }

  const remove = async (id: string) => {
    await fetch(`${API_URL}/api/memory/${id}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {})
    load()
  }

  const reset = async () => {
    if (!confirm('Delete every memory? This cannot be undone.')) return
    await fetch(`${API_URL}/api/memory/reset`, { method: 'POST', headers: authHeaders() }).catch(() => {})
    load()
  }

  const q = query.trim().toLowerCase()
  const filtered = useMemo(
    () => rows.filter((m) => !q || m.content.toLowerCase().includes(q) || m.tags.some((t) => t.toLowerCase().includes(q))),
    [rows, q],
  )
  const groups = useMemo(() => {
    const untagged: MemoryRow[] = []
    const byTag = new Map<string, MemoryRow[]>()
    for (const m of filtered) {
      const tags = m.tags.filter(Boolean)
      if (!tags.length) untagged.push(m)
      for (const t of tags) {
        if (!byTag.has(t)) byTag.set(t, [])
        byTag.get(t)!.push(m)
      }
    }
    return { untagged, byTag }
  }, [filtered])

  const renderItem = (m: MemoryRow) => (
    <Card
      key={m.id}
      title={editingId === m.id ? (
        <div className="flex items-center gap-2 w-full">
          <input
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditingId(null) }}
            autoFocus
            className={inputCls + ' !mt-0 text-[13px]'}
            aria-label="Edit memory"
          />
          <button onClick={saveEdit} className="p-1.5 rounded-lg text-emerald-400 hover:bg-white/5" title="Save"><Check size={14} /></button>
          <button onClick={() => setEditingId(null)} className="p-1.5 rounded-lg text-slate-500 hover:bg-white/5" title="Cancel"><X size={14} /></button>
        </div>
      ) : m.content}
      description={editingId === m.id ? undefined : `updated ${timeAgo(m.updatedAt)}`}
      badge={editingId === m.id ? undefined : (m.source === 'agent' ? <Badge tone="amber">learned</Badge> : <Badge>you added</Badge>)}
      actions={editingId === m.id ? undefined : (
        <>
          <button
            onClick={() => { setEditingId(m.id); setEditText(m.content) }}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/5"
            title="Edit memory" aria-label="Edit memory"
          ><Pencil size={14} /></button>
          <button
            onClick={() => remove(m.id)}
            className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-white/5"
            title="Delete memory" aria-label="Delete memory"
          ><Trash2 size={14} /></button>
        </>
      )}
    >
      {editingId !== m.id && m.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {m.tags.map((t) => <Badge key={t}>{t}</Badge>)}
        </div>
      )}
    </Card>
  )

  return (
    <div className="space-y-4 text-sm">
      {/* Master toggle */}
      <div className="flex items-start justify-between gap-3 p-3.5 rounded-xl border border-white/[0.06] bg-white/[0.02]">
        <div>
          <div className="text-sm font-medium text-slate-100">Use memory across conversations</div>
          <div className="text-xs text-slate-500 mt-0.5">When on, memories are included in every new chat and the assistant can save new ones.</div>
        </div>
        <Toggle on={enabled} onChange={toggleEnabled} label="Use memory across conversations" />
      </div>

      {/* Add */}
      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add() }}
          placeholder="e.g. I prefer concise answers in British English"
          className={inputCls}
          aria-label="New memory"
        />
        <button onClick={add} className={btnPrimary}><Plus size={14} /> Add</button>
      </div>
      {error && <div className="text-xs text-rose-400">{error}</div>}

      {/* List */}
      {rows.length > 0 && (
        <SearchInput value={query} onChange={setQuery} placeholder="Search memories…" resultCount={q ? filtered.length : null} />
      )}

      {rows.length === 0 && (
        <EmptyState
          icon={<Brain size={22} />}
          title="Nothing remembered yet"
          body={'Say "remember that…" in any chat, or add a memory above. The assistant will use it in future conversations.'}
        />
      )}

      {rows.length > 0 && filtered.length === 0 && (
        <p className="text-center text-xs text-slate-600 py-3">No memories match “{query}”.</p>
      )}

      {filtered.length > 0 && (
        <>
          {[...groups.byTag.entries()].map(([tag, items]) => (
            <div key={tag} className="space-y-2">
              <SectionHeader title={tag} count={items.length} />
              {items.map(renderItem)}
            </div>
          ))}
          {groups.untagged.length > 0 && (
            <div className="space-y-2">
              {groups.byTag.size > 0 && <SectionHeader title="Other" count={groups.untagged.length} />}
              {groups.untagged.map(renderItem)}
            </div>
          )}
        </>
      )}

      {rows.length > 0 && (
        <div className="flex justify-end pt-1">
          <button onClick={reset} className={btnGhost + ' text-rose-400 hover:bg-rose-500/10'}><Trash2 size={13} /> Reset all</button>
        </div>
      )}
    </div>
  )
}
