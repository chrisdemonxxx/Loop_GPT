'use client'

import { useEffect, useState } from 'react'
import { Blocks, ChevronLeft, FileCode2, Loader2, Plus, Save, Trash2 } from 'lucide-react'
import { API_URL, authHeaders } from '../../lib/api'
import { Badge, btnGhost, btnPrimary, Card, EmptyState, inputCls, SearchInput, SectionHeader, Toggle } from '../ui/primitives'

interface SkillSummary { id: string; name: string; description: string; enabled: boolean; builtin?: boolean }
interface SkillDetail extends SkillSummary { instructions: string; triggers: string[]; tools: string[]; source: string | null }

/** Compose the SKILL.md preview from form fields (matches the backend writer). */
function composeSkillMd(name: string, description: string, triggers: string, tools: string, instructions: string): string {
  const fm = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    triggers ? `triggers: ${triggers}` : '',
    tools ? `tools: ${tools}` : '',
    '---',
    '',
  ].filter((l) => l !== '').join('\n')
  return `${fm}${instructions.trim()}\n`
}

/**
 * Skills (Claude Agent-Skills style): card list with built-in/custom badges and
 * toggles, a detail view with full instructions, an "Edit source" (SKILL.md)
 * editor, and a create flow with live YAML-frontmatter preview.
 */
export default function SkillsTab() {
  const [items, setItems] = useState<SkillSummary[]>([])
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [creating, setCreating] = useState(false)
  const [editSource, setEditSource] = useState(false)
  const [sourceDraft, setSourceDraft] = useState('')
  const [form, setForm] = useState({ name: '', description: '', triggers: '', tools: '', instructions: '' })
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => fetch(`${API_URL}/api/agent/skills`, { headers: authHeaders() }).then((r) => r.json()).then(setItems).catch(() => {})
  useEffect(() => { load() }, [])

  const openDetail = async (id: string) => {
    setError(''); setEditSource(false)
    const res = await fetch(`${API_URL}/api/agent/skills/${id}`, { headers: authHeaders() }).catch(() => null)
    if (!res?.ok) return
    setDetail(await res.json())
  }

  const toggle = async (id: string, enabled: boolean) => {
    setItems((p) => p.map((i) => (i.id === id ? { ...i, enabled } : i)))
    await fetch(`${API_URL}/api/agent/skills/${id}`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ enabled }) }).catch(() => {})
  }

  const remove = async (id: string) => {
    await fetch(`${API_URL}/api/agent/skills/${id}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {})
    if (detail?.id === id) setDetail(null)
    load()
  }

  const create = async () => {
    if (!form.name || !form.instructions) { setError('Name and instructions are required.'); return }
    setError('')
    const res = await fetch(`${API_URL}/api/agent/skills`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(form) })
    if (!res.ok) { setError((await res.json().catch(() => ({}))).error || 'Could not save.'); return }
    setForm({ name: '', description: '', triggers: '', tools: '', instructions: '' }); setCreating(false); load()
  }

  /** Save the raw SKILL.md source (Edit source) by parsing frontmatter back out. */
  const saveSource = async () => {
    if (!detail) return
    setBusy(true)
    try {
      const raw = sourceDraft
      const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
      const meta: Record<string, string> = {}
      let body = raw
      if (fm) {
        body = fm[2]
        for (const line of fm[1].split('\n')) {
          const idx = line.indexOf(':')
          if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
        }
      }
      const res = await fetch(`${API_URL}/api/agent/skills/${detail.id}`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({
          name: meta.name || detail.name,
          description: meta.description || '',
          instructions: body.trim(),
          triggers: meta.triggers, tools: meta.tools,
        }),
      })
      if (!res.ok) { setError((await res.json().catch(() => ({}))).error || 'Could not save.'); return }
      setEditSource(false); setError('')
      await openDetail(detail.id)
      load()
    } finally { setBusy(false) }
  }

  const q = query.trim().toLowerCase()
  const filtered = items.filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))

  // ---- Detail view ---------------------------------------------------------
  if (detail) {
    return (
      <div className="space-y-3 text-sm">
        <button onClick={() => setDetail(null)} className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition">
          <ChevronLeft size={14} /> All skills
        </button>
        <div className="flex items-start justify-between gap-3 p-3.5 rounded-xl border border-white/[0.06] bg-white/[0.02]">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold text-slate-100">{detail.name}</span>
              {detail.builtin ? <Badge>built-in</Badge> : <Badge tone="accent">custom</Badge>}
            </div>
            <div className="text-xs text-slate-500 mt-1">{detail.description}</div>
            {(detail.triggers.length > 0 || detail.tools.length > 0) && (
              <div className="flex flex-wrap gap-1 mt-2">
                {detail.triggers.map((t) => <Badge key={t} tone="amber">trigger: {t}</Badge>)}
                {detail.tools.map((t) => <Badge key={t} tone="green">tool: {t}</Badge>)}
              </div>
            )}
          </div>
          <Toggle on={detail.enabled} onChange={(v) => { toggle(detail.id, v); setDetail({ ...detail, enabled: v }) }} label={`Enable ${detail.name}`} />
        </div>

        <SectionHeader title="Instructions" action={!detail.builtin ? (
          <button onClick={() => { setSourceDraft(detail.source || ''); setEditSource((v) => !v) }} className="flex items-center gap-1 text-[11px] text-[#e79d7f] hover:underline">
            <FileCode2 size={11} /> {editSource ? 'Close editor' : 'Edit source'}
          </button>
        ) : undefined} />

        {editSource ? (
          <div className="space-y-2">
            <textarea
              value={sourceDraft}
              onChange={(e) => setSourceDraft(e.target.value)}
              rows={14}
              spellCheck={false}
              className="w-full bg-ink-800 border border-white/10 rounded-lg px-3 py-2.5 text-[12px] font-mono text-slate-200 focus:outline-none focus:accent-ring"
              aria-label="SKILL.md source"
            />
            {error && <div className="text-xs text-rose-400">{error}</div>}
            <div className="flex gap-2">
              <button onClick={saveSource} disabled={busy} className={btnPrimary}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save source</button>
              <button onClick={() => setEditSource(false)} className={btnGhost}>Cancel</button>
            </div>
          </div>
        ) : (
          <pre className="p-3.5 rounded-xl border border-white/[0.06] bg-white/[0.02] text-[12.5px] text-slate-300 whitespace-pre-wrap font-sans leading-relaxed">{detail.instructions}</pre>
        )}

        {!detail.builtin && (
          <div className="flex justify-end pt-1">
            <button onClick={() => remove(detail.id)} className={btnGhost + ' text-rose-400 hover:bg-rose-500/10'}><Trash2 size={13} /> Delete skill</button>
          </div>
        )}
      </div>
    )
  }

  // ---- List view -----------------------------------------------------------
  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center justify-between">
        <p className="text-slate-500">Skills inject expert instructions when their triggers match. Ask “create a skill” in any chat, or add one here.</p>
        <button onClick={() => setCreating((v) => !v)} className="flex items-center gap-1 text-xs text-[#e79d7f] hover:underline shrink-0"><Plus size={13} /> Create skill</button>
      </div>

      {creating && (
        <div className="p-3.5 rounded-xl border border-dashed border-white/10 space-y-2 bg-white/[0.015]">
          <div className="grid grid-cols-2 gap-2">
            <input placeholder="Skill name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} aria-label="Skill name" />
            <input placeholder="Trigger keywords (comma-separated, optional)" value={form.triggers} onChange={(e) => setForm({ ...form, triggers: e.target.value })} className={inputCls} aria-label="Triggers" />
          </div>
          <input placeholder="Short description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputCls} aria-label="Description" />
          <input placeholder="Recommended tools (comma-separated, e.g. web_search, create_document)" value={form.tools} onChange={(e) => setForm({ ...form, tools: e.target.value })} className={inputCls} aria-label="Tools" />
          <textarea placeholder="Instructions the agent should follow when this skill is active…" rows={4} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} className={inputCls} aria-label="Instructions" />
          <details className="group">
            <summary className="text-[11px] text-slate-500 cursor-pointer hover:text-slate-300 flex items-center gap-1"><FileCode2 size={11} /> SKILL.md preview</summary>
            <pre className="mt-1.5 p-2.5 rounded-lg bg-ink-800 border border-white/10 text-[11px] font-mono text-slate-400 whitespace-pre-wrap">{composeSkillMd(form.name || 'skill-name', form.description || '…', form.triggers, form.tools, form.instructions || 'instructions…')}</pre>
          </details>
          {error && <div className="text-xs text-rose-400">{error}</div>}
          <div className="flex gap-2">
            <button onClick={create} className={btnPrimary}>Save skill</button>
            <button onClick={() => setCreating(false)} className={btnGhost}>Cancel</button>
          </div>
        </div>
      )}

      {items.length > 0 && <SearchInput value={query} onChange={setQuery} placeholder="Search skills…" resultCount={q ? filtered.length : null} />}

      {items.length === 0 && (
        <EmptyState icon={<Blocks size={22} />} title="No skills yet" body="Skills teach the assistant reusable workflows. Just ask “create a skill for…” in a chat, or use Create skill above." />
      )}

      <div className="space-y-2">
        {filtered.map((s) => (
          <Card
            key={s.id}
            title={s.name}
            description={s.description}
            badge={s.builtin ? <Badge>built-in</Badge> : <Badge tone="accent">custom</Badge>}
            onClick={() => openDetail(s.id)}
            actions={
              <>
                {!s.builtin && (
                  <button
                    onClick={(e) => { e.stopPropagation(); remove(s.id) }}
                    className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-white/5"
                    title="Delete skill" aria-label="Delete skill"
                  ><Trash2 size={14} /></button>
                )}
                <div onClick={(e) => e.stopPropagation()}>
                  <Toggle on={s.enabled} onChange={(v) => toggle(s.id, v)} label={`Enable ${s.name}`} />
                </div>
              </>
            }
          />
        ))}
      </div>
    </div>
  )
}
