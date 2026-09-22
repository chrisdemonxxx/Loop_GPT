'use client'

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { X, FolderPlus, Trash2, Upload, Check, Database, MessageSquare, ChevronLeft, FileText } from 'lucide-react'
import { API_URL, authHeaders } from '../lib/api'
import { Badge, btnGhost, btnPrimary, inputCls } from './ui/primitives'

export interface Project {
  id: string
  name: string
  instructions: string
  createdAt: string
  updatedAt: string
  _count?: { knowledgeChunks: number; conversations: number }
}

interface Props {
  workspaceId: string | null
  activeProjectId: string | null
  onSelect: (id: string | null) => void
  onClose: () => void
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** Read a knowledge file (txt/md/csv) client-side for ingestion. */
async function readTextFile(file: File): Promise<string> {
  if (/\.csv$/i.test(file.name)) {
    const text = await file.text()
    return text.split(/\r?\n/).map((line) => line.split(',').map((cell) => cell.replace(/^"|"$/g, '')).join(' · ')).join('\n')
  }
  return file.text()
}

/**
 * Projects (Claude-style): a vertical card list with instructions preview,
 * chat counts and last-active, a dedicated creation flow, and a prominent
 * knowledge upload (text files are parsed in the browser).
 */
export default function ProjectsPanel({ workspaceId, activeProjectId, onSelect, onClose }: Props) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // Creation flow (dedicated): details step → knowledge step.
  const [creating, setCreating] = useState(false)
  const [step, setStep] = useState<1 | 2>(1)
  const [form, setForm] = useState({ name: '', instructions: '' })
  const [seedFiles, setSeedFiles] = useState<File[]>([])
  const [seedMsg, setSeedMsg] = useState('')
  const [busy, setBusy] = useState(false)

  // Per-project knowledge upload.
  const [ingestFor, setIngestFor] = useState<string | null>(null)
  const [ingestText, setIngestText] = useState('')
  const [ingestMsg, setIngestMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  // Escape closes the modal — must work even when focus is in a textarea
  // (e.g. the project name input), so we listen on document, not via useHotkey
  // (which intentionally skips when the target is an INPUT/TEXTAREA).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function load() {
    if (!workspaceId) { setProjects([]); setLoading(false); return }
    setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/projects`, { headers: authHeaders() })
      const data = await res.json()
      setProjects(Array.isArray(data) ? data : [])
    } catch { setError('Could not load projects.') } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [workspaceId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function create() {
    if (!workspaceId || !form.name.trim()) return
    setBusy(true); setError('')
    try {
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/projects`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ name: form.name.trim(), instructions: form.instructions.trim() }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to create')
      const project = await res.json()
      // Optional seed knowledge from the creation flow.
      for (const file of seedFiles) {
        const isDoc = /\.(pdf|docx|xlsx)$/i.test(file.name)
        if (isDoc) {
          const fd = new FormData()
          fd.append('file', file)
          await fetch(`${API_URL}/api/workspaces/${workspaceId}/projects/${project.id}/ingest-file`, {
            method: 'POST', headers: authHeaders(false) as Record<string, string>, body: fd,
          }).catch(() => {})
        } else {
          const text = await readTextFile(file).catch(() => '')
          if (text.trim()) {
            await fetch(`${API_URL}/api/workspaces/${workspaceId}/projects/${project.id}/ingest`, {
              method: 'POST', headers: authHeaders(), body: JSON.stringify({ text }),
            }).catch(() => {})
          }
        }
      }
      setForm({ name: '', instructions: '' }); setSeedFiles([]); setSeedMsg('')
      setCreating(false); setStep(1)
      await load()
      onSelect(project.id)
    } catch (err: any) { setError(err?.message || 'Failed to create') } finally { setBusy(false) }
  }

  async function remove(id: string) {
    if (!workspaceId || !confirm('Delete this project and its knowledge?')) return
    await fetch(`${API_URL}/api/workspaces/${workspaceId}/projects/${id}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {})
    if (activeProjectId === id) onSelect(null)
    load()
  }

  async function ingest(id: string) {
    if (!workspaceId || !ingestText.trim()) return
    setIngestMsg('')
    const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/projects/${id}/ingest`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: ingestText }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) { setIngestMsg(`Indexed ${data.inserted}/${data.total} chunks.`); setIngestText(''); load() }
    else setIngestMsg(data.error || 'Ingest failed')
  }

  async function ingestFiles(id: string, files: File[]) {
    if (!workspaceId || !files.length) return
    setIngestMsg(`Reading ${files.length} file${files.length > 1 ? 's' : ''}…`)
    let indexed = 0
    let failures = 0
    for (const file of files.slice(0, 5)) {
      const isDoc = /\.(pdf|docx|xlsx)$/i.test(file.name)
      try {
        let res: Response | null = null
        if (isDoc) {
          // Documents extract server-side (PDF/DOCX/XLSX).
          const fd = new FormData()
          fd.append('file', file)
          res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/projects/${id}/ingest-file`, {
            method: 'POST', headers: authHeaders(false) as Record<string, string>, body: fd,
          })
        } else {
          // Plain text formats parse in the browser, as before.
          const text = await readTextFile(file).catch(() => '')
          if (!text.trim()) { failures++; continue }
          res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/projects/${id}/ingest`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify({ text }),
          })
        }
        if (res?.ok) indexed++
        else {
          failures++
          const err = await res?.json().catch(() => null)
          if (err?.error) setIngestMsg(`${file.name}: ${err.error}`)
        }
      } catch { failures++ }
    }
    setIngestMsg(indexed ? `Indexed ${indexed} file${indexed > 1 ? 's' : ''}${failures ? ` (${failures} failed)` : ''}.` : 'No files could be indexed.')
    load()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="glass-strong rounded-2xl w-full max-w-xl max-h-[85vh] overflow-y-auto border border-white/10 p-5"
        role="dialog" aria-modal="true" aria-label="Projects"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-slate-100">Projects</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 -m-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-white/5 transition"
          >
            <X size={16} />
          </button>
        </div>

        {/* Create — dedicated flow */}
        {creating ? (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 space-y-3">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-slate-500">
              {step === 1 ? <ChevronLeft size={12} /> : <button onClick={() => setStep(1)} className="flex items-center gap-1 hover:text-slate-300"><ChevronLeft size={12} /> Back</button>}
              Step {step} of 2 · {step === 1 ? 'Details' : 'Knowledge'}
            </div>
            {step === 1 && (
              <>
                <input placeholder="Project name (e.g. Marketing, Thesis)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} aria-label="Project name" />
                <textarea placeholder="Custom instructions the agent should follow in this project…" rows={3} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} className={inputCls} aria-label="Project instructions" />
                <button onClick={() => setStep(2)} disabled={!form.name.trim()} className={btnPrimary}>Continue</button>
              </>
            )}
            {step === 2 && (
              <>
                <p className="text-xs text-slate-500">Optional: add knowledge files now, or skip — you can upload anytime from the project card.</p>
                <button
                  onClick={() => fileRef.current?.click()}
                  className="w-full flex flex-col items-center gap-2 py-6 rounded-xl border border-dashed border-white/10 hover:border-white/20 hover:bg-white/[0.02] transition"
                >
                  <Upload size={20} className="text-slate-500" />
                  <span className="text-[13px] text-slate-300">Upload knowledge files</span>
                  <span className="text-[11px] text-slate-600">.txt · .md · .csv · .pdf · .docx · .xlsx</span>
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".txt,.md,.markdown,.csv,.pdf,.docx,.xlsx,text/plain,text/markdown,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  multiple
                  className="hidden"
                  onChange={(e) => { const f = Array.from(e.target.files || []); setSeedFiles(f); setSeedMsg(f.length ? `${f.length} file(s) ready to index` : ''); e.target.value = '' }}
                />
                {seedMsg && <div className="text-[11px] text-slate-400">{seedMsg}</div>}
                <div className="flex gap-2">
                  <button onClick={create} disabled={busy} className={btnPrimary}><FolderPlus size={14} /> Create project</button>
                  <button onClick={() => { setCreating(false); setStep(1); setError('') }} className={btnGhost}>Cancel</button>
                </div>
              </>
            )}
            {error && <div className="text-xs text-rose-400">{error}</div>}
          </div>
        ) : (
          <button onClick={() => setCreating(true)} className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium text-white bg-[#c96442] hover:bg-[#b5593a] transition">
            <FolderPlus size={15} /> New project
          </button>
        )}

        {loading && <div className="text-sm text-slate-500 py-4 text-center">Loading…</div>}

        {/* Project cards */}
        <div className="mt-4 space-y-2.5">
          {!loading && projects.length === 0 && (
            <div className="py-8 text-center">
              <div className="text-sm text-slate-300">No projects yet</div>
              <div className="text-xs text-slate-500 mt-1 max-w-[300px] mx-auto leading-relaxed">Projects scope chats to a set of instructions and a searchable knowledge base.</div>
            </div>
          )}
          {projects.map((p) => {
            const active = activeProjectId === p.id
            return (
              <div
                key={p.id}
                className={`rounded-xl border p-3.5 transition ${active ? 'border-[#c96442]/40 bg-[#c96442]/[0.06]' : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.035]'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${active ? 'bg-[#c96442]' : 'bg-slate-600'}`} />
                      <span className="text-sm font-medium text-slate-100 truncate">{p.name}</span>
                      {active && <Badge tone="accent">active</Badge>}
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-slate-500 mt-1">
                      <span className="flex items-center gap-1"><MessageSquare size={10} /> {p._count?.conversations ?? 0} chats</span>
                      <span className="flex items-center gap-1"><Database size={10} /> {p._count?.knowledgeChunks ?? 0} knowledge</span>
                      <span>· {timeAgo(p.updatedAt)}</span>
                    </div>
                    {p.instructions && <div className="text-[11px] text-slate-500 mt-1.5 line-clamp-2">{p.instructions}</div>}
                  </div>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <button
                      onClick={() => onSelect(active ? null : p.id)}
                      className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12px] font-medium transition ${
                        active ? 'bg-[#c96442]/20 text-[#e79d7f]' : 'text-white bg-[#c96442] hover:bg-[#b5593a]'
                      }`}
                    >
                      {active ? <><Check size={12} /> Active</> : 'Open'}
                    </button>
                    <button onClick={() => remove(p.id)} title="Delete project" aria-label="Delete project" className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-white/5 transition"><Trash2 size={13} /></button>
                  </div>
                </div>

                {/* Knowledge upload — prominent, per project */}
                {ingestFor === p.id ? (
                  <div className="mt-3 pt-3 border-t border-white/[0.06] space-y-2">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => fileRef.current?.click()}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] bg-white/[0.05] text-slate-200 hover:bg-white/[0.09] transition"
                      ><FileText size={12} /> Upload text or document files</button>
                      <span className="text-[11px] text-slate-600">or paste text:</span>
                    </div>
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".txt,.md,.markdown,.csv,.pdf,.docx,.xlsx,text/plain,text/markdown,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                      multiple
                      className="hidden"
                      onChange={(e) => { ingestFiles(p.id, Array.from(e.target.files || [])); e.target.value = '' }}
                    />
                    <textarea value={ingestText} onChange={(e) => setIngestText(e.target.value)} rows={3} placeholder="Paste docs, notes, or reference text…" className={inputCls} aria-label="Knowledge text" />
                    <div className="flex items-center gap-2">
                      <button onClick={() => ingest(p.id)} disabled={!ingestText.trim()} className={btnPrimary + ' !py-1.5 text-[12px]'}>Add to knowledge</button>
                      {ingestMsg && <span className="text-[11px] text-slate-400">{ingestMsg}</span>}
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => { setIngestFor(ingestFor === p.id ? null : p.id); setIngestMsg('') }}
                    className="mt-2.5 flex items-center gap-1.5 text-[11px] text-slate-500 hover:text-[#e79d7f] transition"
                  >
                    <Upload size={11} /> Add knowledge
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </motion.div>
    </div>
  )
}
