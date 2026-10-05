'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, BookOpen, FileUp, Loader2, MessageSquare, Save, Search, Sparkles,
} from 'lucide-react'
import { API_URL, authHeaders } from '../lib/api'
import { useWorkspaceProjects } from '../chat/hooks'

interface ProjectRow {
  id: string; name: string; role: string; instructions: string
  createdAt: string; updatedAt: string
  _count: { knowledgeChunks: number; conversations: number }
}
interface ConversationRow { id: string; title: string; updatedAt: string; projectId?: string | null }
interface SearchHit { chunk?: { content?: string }; content?: string; text?: string; score?: number }

function idFromLocation(search: string): string {
  const raw = search.startsWith('?') ? search.slice(1) : search
  const id = new URLSearchParams(raw).get('id')
  return id && id.trim() ? id.trim().slice(0, 64) : ''
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 3600) return 'just now'
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/**
 * Project detail (blueprint §A2.3 → query-param adaptation, contract
 * team/CONTRACT_S3_ROUTES.md §1 pattern): instructions editor (real PATCH),
 * knowledge card (count + ingest text/file + vector search — all real
 * endpoints), and the project's chats scoped client-side from the
 * conversation list.
 */
export default function ProjectDetailPage() {
  const router = useRouter()
  const { workspaceId } = useWorkspaceProjects()
  const [projectId, setProjectId] = useState('')
  const [project, setProject] = useState<ProjectRow | null>(null)
  const [missing, setMissing] = useState(false)
  const [chats, setChats] = useState<ConversationRow[]>([])
  const [instructions, setInstructions] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'ok' | 'error'>('idle')
  const [ingestText, setIngestText] = useState('')
  const [ingestMsg, setIngestMsg] = useState('')
  const [ingesting, setIngesting] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setProjectId(idFromLocation(window.location.search)) }, [])

  const reload = async () => {
    if (!workspaceId || !projectId) return
    try {
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/projects`, { headers: authHeaders() })
      if (!res.ok) throw new Error('load')
      const list: ProjectRow[] = await res.json()
      const found = list.find((p) => p.id === projectId) || null
      setProject(found)
      setMissing(!found)
      if (found && !dirty) setInstructions(found.instructions || '')
    } catch {
      setMissing(true)
    }
    try {
      const res = await fetch(`${API_URL}/api/conversations`, { headers: authHeaders() })
      const list: ConversationRow[] = res.ok ? await res.json() : []
      setChats(Array.isArray(list) ? list.filter((c) => c.projectId === projectId) : [])
    } catch { setChats([]) }
  }
  useEffect(() => { reload() }, [workspaceId, projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  const saveInstructions = async () => {
    if (!workspaceId || !project) return
    setSaving(true); setSaveState('idle')
    try {
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/projects/${project.id}`, {
        method: 'PATCH', headers: authHeaders(),
        body: JSON.stringify({ instructions: instructions.trim() }),
      })
      if (!res.ok) throw new Error('save')
      setDirty(false); setSaveState('ok')
    } catch { setSaveState('error') } finally { setSaving(false) }
  }

  const ingest = async () => {
    if (!workspaceId || !project || !ingestText.trim()) return
    setIngesting(true); setIngestMsg('')
    try {
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/projects/${project.id}/ingest`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ text: ingestText.trim() }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setIngestMsg(d.error || 'Could not add that text.'); return }
      setIngestText('')
      setIngestMsg(`Indexed ${d.chunks ?? d.count ?? ''}${d.chunks ? ' passages' : ''}.`.trim() || 'Indexed.')
      reload()
    } finally { setIngesting(false) }
  }

  const uploadFile = async (file: File) => {
    if (!workspaceId || !project) return
    setIngesting(true); setIngestMsg('')
    try {
      const body = new FormData()
      body.append('file', file)
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/projects/${project.id}/ingest-file`, {
        method: 'POST', headers: authHeaders(false), body,
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setIngestMsg(d.error || 'Could not ingest that file.'); return }
      setIngestMsg(`Indexed ${file.name}.`)
      reload()
    } finally { setIngesting(false) }
  }

  const search = async () => {
    if (!workspaceId || !project || !query.trim()) return
    setSearching(true); setResults(null)
    try {
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/projects/${project.id}/search?q=${encodeURIComponent(query.trim())}`, { headers: authHeaders() })
      const d = await res.json().catch(() => ({}))
      setResults(Array.isArray(d.results) ? d.results : [])
    } catch { setResults([]) } finally { setSearching(false) }
  }

  return (
    <main className="min-h-screen bg-[#08080a] px-5 py-6 max-w-3xl mx-auto text-slate-200">
      <Link href="/projects" className="inline-flex items-center gap-1.5 text-[12px] text-slate-400 transition hover:text-slate-200">
        <ArrowLeft size={14} /> Projects
      </Link>

      {missing && (
        <div className="mt-6 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-6 text-center">
          <p className="text-[14px] text-slate-300">That project does not exist</p>
          <p className="mt-1 text-[12px] text-slate-500">It may have been deleted, or the link is stale.</p>
          <Link href="/projects" className="mt-3 inline-block text-[12px] text-[#e79d7f] hover:underline">Back to projects</Link>
        </div>
      )}

      {project && (
        <div className="mt-4 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold text-slate-100">{project.name}</h1>
              <p className="mt-0.5 text-[12px] text-slate-500">
                Your role: {project.role} · {project._count.conversations} chat{project._count.conversations === 1 ? '' : 's'} ·
                {' '}{project._count.knowledgeChunks} indexed passage{project._count.knowledgeChunks === 1 ? '' : 's'}
              </p>
            </div>
            <Link
              href={`/chat?project=${encodeURIComponent(project.id)}`}
              className="inline-flex items-center gap-2 rounded-xl border border-[#c96442]/40 bg-[#c96442]/[0.08] px-4 py-2 text-[13px] font-medium text-[#e79d7f] transition hover:bg-[#c96442]/[0.14]"
            >
              <Sparkles size={14} /> Open in chat
            </Link>
          </div>

          <section aria-label="Instructions" className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-[13px] text-slate-300"><BookOpen size={14} className="text-slate-500" /> Project instructions</div>
              <button
                type="button"
                onClick={saveInstructions}
                disabled={saving || !dirty}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#c96442]/40 bg-[#c96442]/[0.08] px-3 py-1.5 text-[12px] font-medium text-[#e79d7f] transition hover:bg-[#c96442]/[0.14] disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save
              </button>
            </div>
            <textarea
              value={instructions}
              onChange={(e) => { setInstructions(e.target.value); setDirty(true); setSaveState('idle') }}
              aria-label="Project instructions"
              rows={4}
              maxLength={5000}
              placeholder="What should the assistant know about this project? (goals, style, constraints)"
              className="mt-2.5 w-full resize-y rounded-lg border border-white/10 bg-ink-800 px-3 py-2 text-[13px] leading-relaxed text-slate-200 placeholder:text-slate-600 focus:border-[#c96442]/50 focus:outline-none"
            />
            {saveState === 'ok' && <p className="mt-1.5 text-[11px] text-emerald-400" role="status">Saved.</p>}
            {saveState === 'error' && <p className="mt-1.5 text-[11px] text-rose-400" role="alert">Could not save. Try again.</p>}
          </section>

          <section aria-label="Knowledge" className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
            <div className="text-[13px] text-slate-300">Project knowledge</div>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              Everything indexed here is retrieved into the chat when this project is active.
            </p>
            <div className="mt-2.5 space-y-2">
              <textarea
                value={ingestText}
                onChange={(e) => setIngestText(e.target.value)}
                aria-label="Add text to project knowledge"
                rows={3}
                placeholder="Paste notes, specs or context to index…"
                className="w-full resize-y rounded-lg border border-white/10 bg-ink-800 px-3 py-2 text-[12px] leading-relaxed text-slate-200 placeholder:text-slate-600 focus:border-[#c96442]/50 focus:outline-none"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={ingest}
                  disabled={ingesting || !ingestText.trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-slate-200 transition hover:border-white/25 hover:text-white disabled:opacity-50"
                >
                  {ingesting ? <Loader2 size={12} className="animate-spin" /> : <BookOpen size={12} />} Add text
                </button>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={ingesting}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-slate-200 transition hover:border-white/25 hover:text-white disabled:opacity-50"
                >
                  <FileUp size={12} /> Upload file
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  accept=".pdf,.docx,.xlsx,.csv,.txt,.md"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFile(f); e.target.value = '' }}
                />
                {ingestMsg && <span className={`text-[11px] ${ingestMsg.startsWith('Indexed') || ingestMsg.startsWith('Added') ? 'text-emerald-400' : 'text-rose-400'}`} role="status">{ingestMsg}</span>}
              </div>
            </div>

            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => { e.preventDefault(); void search() }}
            >
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search project knowledge"
                placeholder="Search what the project knows…"
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-ink-800 px-3 py-1.5 text-[12px] text-slate-200 placeholder:text-slate-600 focus:border-[#c96442]/50 focus:outline-none"
              />
              <button
                type="submit"
                disabled={searching || !query.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-slate-200 transition hover:border-white/25 hover:text-white disabled:opacity-50"
              >
                {searching ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />} Search
              </button>
            </form>
            {results !== null && (
              <ul className="mt-2.5 space-y-1.5">
                {results.map((hit, i) => {
                  const text = hit?.chunk?.content || hit?.content || hit?.text || ''
                  return (
                    <li key={i} className="rounded-lg border border-white/[0.05] bg-white/[0.015] px-3 py-2 text-[12px] leading-relaxed text-slate-400">
                      {text.slice(0, 280)}{text.length > 280 ? '…' : ''}
                    </li>
                  )
                })}
                {results.length === 0 && <li className="text-[12px] text-slate-600">Nothing matched. Add more knowledge and try again.</li>}
              </ul>
            )}
          </section>

          <section aria-label="Project chats" className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
            <div className="text-[13px] text-slate-300">Chats in this project</div>
            <ul className="mt-2 space-y-1.5">
              {chats.map((c) => (
                <li key={c.id}>
                  <Link href={`/chat?conversation=${encodeURIComponent(c.id)}`} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-[13px] text-slate-300 transition hover:bg-white/[0.04] hover:text-slate-100">
                    <span className="flex min-w-0 items-center gap-2"><MessageSquare size={13} className="shrink-0 text-slate-500" /> <span className="truncate">{c.title || 'Untitled chat'}</span></span>
                    <span className="shrink-0 text-[11px] text-slate-500">{timeAgo(c.updatedAt)}</span>
                  </Link>
                </li>
              ))}
              {chats.length === 0 && (
                <li className="text-[12px] text-slate-600">No chats yet — open the project in chat to start one.</li>
              )}
            </ul>
          </section>
        </div>
      )}
    </main>
  )
}