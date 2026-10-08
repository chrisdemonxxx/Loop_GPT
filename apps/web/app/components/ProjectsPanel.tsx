'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { X, FolderPlus, Trash2, Upload, Check, Database, MessageSquare, ChevronLeft, FileText, ExternalLink } from 'lucide-react'
import { API_URL, authHeaders } from '../lib/api'
import { useFocusTrap } from '@loop/ui'
import { Badge, btnGhost, btnPrimary, inputCls } from './ui/primitives'

export interface Project {
  id: string
  name: string
  instructions: string
  createdAt: string
  updatedAt: string
  botIds?: string[]
  _count?: { knowledgeChunks: number; conversations: number }
}

interface Props {
  workspaceId: string | null
  activeProjectId: string | null
  onSelect: (id: string | null) => void
  onClose: () => void
  /** /projects hosts this same panel as a page. Default remains the in-chat dialog. */
  asPage?: boolean
  /** Owner's bots. Assignment UI renders only when this is passed. */
  bots?: Array<{ id: string; name: string }>
  /** Open the project's group room. */
  onOpenRoom?: (room: { id: string; botIds: string[] }) => void
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
 * Projects: a vertical card list with instructions preview, chat counts and
 * last-active, a dedicated creation flow, and a prominent knowledge upload
 * (text files are parsed in the browser). Search and sort stay on the client.
 */
export default function ProjectsPanel({ workspaceId, activeProjectId, onSelect, onClose, asPage = false, bots, onOpenRoom }: Props) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'created' | 'updated' | 'name'>('created')
  // Creation flow (dedicated): details step → knowledge step.
  const [creating, setCreating] = useState(false)
  const [step, setStep] = useState<1 | 2>(1)
  const [form, setForm] = useState({ name: '', instructions: '' })
  const [seedFiles, setSeedFiles] = useState<File[]>([])
  const [seedMsg, setSeedMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const dialogRef = useFocusTrap<HTMLDivElement>(!asPage)

  // Per-project knowledge upload.
  const [ingestFor, setIngestFor] = useState<string | null>(null)
  const [ingestText, setIngestText] = useState('')
  const [ingestMsg, setIngestMsg] = useState('')
  const [roomError, setRoomError] = useState<{ projectId: string; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Escape closes the modal — must work even when focus is in a textarea
  // (e.g. the project name input), so we listen on document, not via useHotkey
  // (which intentionally skips when the target is an INPUT/TEXTAREA).
  useEffect(() => {
    if (asPage) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, asPage])

  async function load() {
    if (!workspaceId) {
      setProjects([])
      setLoaded(false)
      setLoadError('')
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/projects`, { headers: authHeaders() })
      if (!res.ok) throw new Error('load')
      const data = await res.json()
      if (!Array.isArray(data)) throw new Error('load')
      setProjects(data)
      setLoadError('')
      setLoaded(true)
    } catch {
      // Keep whatever list is already on screen. A failure is not an empty library.
      setLoadError('Could not load projects.')
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [workspaceId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleProjectBot(project: Project, botId: string) {
    if (!workspaceId) return
    const current = project.botIds || []
    const next = current.includes(botId) ? current.filter((id) => id !== botId) : [...current, botId]
    setRoomError(null)
    try {
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/projects/${project.id}/bots`, {
        method: 'PUT', headers: authHeaders(), body: JSON.stringify({ botIds: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'Could not update the bots')
      const botIds = Array.isArray(data?.botIds) ? data.botIds as string[] : next
      setProjects((prev) => prev.map((item) => item.id === project.id ? { ...item, botIds } : item))
    } catch (err: any) {
      setRoomError({ projectId: project.id, text: err?.message || 'Could not update the bots' })
    }
  }

  async function openRoom(project: Project) {
    if (!workspaceId) return
    setRoomError(null)
    try {
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/projects/${project.id}/room`, {
        method: 'POST', headers: authHeaders(),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'Could not open the project room')
      onOpenRoom?.({ id: data.id, botIds: Array.isArray(data.botIds) ? data.botIds : (project.botIds || []) })
    } catch (err: any) {
      setRoomError({ projectId: project.id, text: err?.message || 'Could not open the project room' })
    }
  }

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
      // The project exists. A later seed-file failure must not delete it.
      setProjects((prev) => [project, ...prev.filter((item) => item.id !== project.id)])
      try {
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
      } catch { /* seed upload failed; leave the created project in place */ }
      setForm({ name: '', instructions: '' }); setSeedFiles([]); setSeedMsg('')
      setCreating(false); setStep(1)
      await load()
      onSelect(project.id)
    } catch (err: any) { setError(err?.message || 'Failed to create') } finally { setBusy(false) }
  }

  async function remove(id: string) {
    if (!workspaceId || !confirm('Delete this project and its knowledge?')) return
    const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/projects/${id}`, { method: 'DELETE', headers: authHeaders() }).catch(() => null)
    if (!res?.ok) return
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

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = projects.filter((item) => !q || item.name.toLowerCase().includes(q))
    return [...rows].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'updated') return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    })
  }, [projects, query, sort])

  return (
    <div className={asPage ? "min-h-screen bg-[#08080a] text-slate-200" : "fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"} onClick={asPage ? undefined : onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={asPage ? "w-full max-w-xl mx-auto px-5 py-8" : "glass-strong rounded-2xl w-full max-w-xl max-h-[85vh] overflow-y-auto border border-white/10 p-5 outline-none"}
        role={asPage ? "main" : "dialog"} aria-modal={asPage ? undefined : true} aria-label="Projects"
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
                <div className="flex gap-2">
                  <button type="button" onClick={() => setStep(2)} disabled={!form.name.trim()} className={btnPrimary}>Continue</button>
                  <button type="button" onClick={() => { setCreating(false); setStep(1); setError('') }} className={btnGhost}>Cancel</button>
                </div>
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

        {loading && projects.length === 0 && !loadError && <div className="text-sm text-slate-500 py-4 text-center">Loading…</div>}
        {loadError && (
          <div className="mt-4 text-xs text-rose-400 flex items-center gap-2">
            <span>Could not load projects.</span>
            <button type="button" onClick={() => load()} className="underline hover:text-rose-300">Retry</button>
          </div>
        )}

        {/* Project cards. Search and sort are client-side — the GET is unchanged. */}
        <div className="mt-4 space-y-2.5">
          {projects.length > 0 && (
            <div className="flex gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search projects"
                aria-label="Search projects"
                className={inputCls}
              />
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as 'created' | 'updated' | 'name')}
                aria-label="Sort projects"
                className={inputCls + ' !w-auto shrink-0'}
              >
                <option value="created">Newest created</option>
                <option value="updated">Recently updated</option>
                <option value="name">Name</option>
              </select>
            </div>
          )}
          {loaded && !loadError && projects.length === 0 && (
            <div className="py-8 text-center">
              <div className="text-sm text-slate-300">No projects yet</div>
              <div className="text-xs text-slate-500 mt-1 max-w-[300px] mx-auto leading-relaxed">Projects scope chats to a set of instructions and a searchable knowledge base.</div>
            </div>
          )}
          {projects.length > 0 && visible.length === 0 && (
            <p className="text-center text-xs text-slate-500 py-6">No projects match “{query.trim()}”.</p>
          )}
          {visible.map((p) => {
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
                    {bots && (
                      <div className="mt-3">
                        <div className="text-[11px] text-slate-500 mb-1.5">Bots in this room</div>
                        {bots.length === 0 ? (
                          <p className="text-[11px] text-slate-500">Create at least two bots, then assign them here.</p>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {bots.map((bot) => {
                              const on = (p.botIds || []).includes(bot.id)
                              return (
                                <button
                                  key={bot.id}
                                  type="button"
                                  aria-pressed={on}
                                  onClick={() => { void toggleProjectBot(p, bot.id) }}
                                  className={`px-2 py-1 rounded-lg border text-[11px] transition ${on ? 'border-[#c96442]/50 bg-[#c96442]/15 text-[#e79d7f]' : 'border-white/10 text-slate-400 hover:text-slate-200'}`}
                                >
                                  {bot.name}
                                </button>
                              )
                            })}
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => { void openRoom(p) }}
                          className="mt-2 px-2.5 py-1.5 rounded-lg text-[12px] font-medium text-white bg-[#c96442] hover:bg-[#b5593a] transition"
                        >
                          Open project room
                        </button>
                        {roomError?.projectId === p.id && <p className="mt-1.5 text-[11px] text-rose-400">{roomError.text}</p>}
                      </div>
                    )}
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
                    <div className="flex items-center gap-1.5">
                      <Link
                        href={`/project?id=${encodeURIComponent(p.id)}`}
                        title="Project detail"
                        aria-label={`Open project detail for ${p.name}`}
                        className="p-1.5 rounded-lg text-slate-500 transition hover:text-slate-200 hover:bg-white/5"
                      ><ExternalLink size={13} /></Link>
                      <button onClick={() => remove(p.id)} title="Delete project" aria-label="Delete project" className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-white/5 transition"><Trash2 size={13} /></button>
                    </div>
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
                ) : (p._count?.knowledgeChunks ?? 0) === 0 ? (
                  /* Empty knowledge → surface the upload action INLINE (P2 discoverability). */
                  <button
                    onClick={() => { setIngestFor(p.id); setIngestMsg('') }}
                    className="mt-3 w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-dashed border-[#c96442]/30 text-[12.5px] text-[#e79d7f] hover:bg-[#c96442]/[0.06] transition"
                  >
                    <Upload size={13} /> Upload knowledge — no knowledge yet
                  </button>
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
