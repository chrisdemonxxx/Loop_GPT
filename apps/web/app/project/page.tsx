'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BookOpen, FileUp, Loader2, MessageSquare, Save, Search, Sparkles,
} from 'lucide-react'
import { API_URL, authHeaders } from '../lib/api'
import { useWorkspaceProjects } from '../chat/hooks'
import { AppPage } from '../components/AppPage'
import { ErrorState, LoadingState, btnOutline, btnSecondary, inputCls, linkCls, panelCls, textareaCls } from '@loop/ui'

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
  const { workspaceId } = useWorkspaceProjects()
  const queryClient = useQueryClient()
  const [projectId, setProjectId] = useState('')
  useEffect(() => { setProjectId(idFromLocation(window.location.search)) }, [])

  const projectQuery = useQuery<ProjectRow | null>({
    queryKey: ['project', workspaceId, projectId],
    queryFn: async () => {
      if (!workspaceId || !projectId) return null
      try {
        const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/projects`, { headers: authHeaders() })
        if (!res.ok) throw new Error('load')
        const list: ProjectRow[] = await res.json()
        return list.find((p) => p.id === projectId) || null
      } catch {
        return null
      }
    },
    enabled: typeof window !== 'undefined' && !!workspaceId && !!projectId,
    retry: false,
  })
  const project = projectQuery.data ?? null

  const chatsQuery = useQuery<ConversationRow[]>({
    queryKey: ['project-chats', projectId],
    queryFn: async () => {
      try {
        const res = await fetch(`${API_URL}/api/conversations`, { headers: authHeaders() })
        const list: ConversationRow[] = res.ok ? await res.json() : []
        return Array.isArray(list) ? list.filter((c) => c.projectId === projectId) : []
      } catch {
        return []
      }
    },
    enabled: typeof window !== 'undefined' && !!projectId,
    retry: false,
  })
  const chats = chatsQuery.data ?? []

  const [instructions, setInstructions] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'ok' | 'error'>('idle')
  const [ingestText, setIngestText] = useState('')
  const [ingestMsg, setIngestMsg] = useState('')
  const [ingesting, setIngesting] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Prefill the editor from the fetched project unless the user is editing.
  useEffect(() => {
    if (project && !dirty) setInstructions(project.instructions || '')
  }, [project, dirty])

  const missing = projectQuery.isSuccess && project === null

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!workspaceId || !project) throw new Error('no project')
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/projects/${project.id}`, {
        method: 'PATCH', headers: authHeaders(),
        body: JSON.stringify({ instructions: instructions.trim() }),
      })
      if (!res.ok) throw new Error('save')
    },
    onSuccess: () => { setDirty(false); setSaveState('ok') },
    onError: () => { setSaveState('error') },
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['project', workspaceId, projectId] })
    void queryClient.invalidateQueries({ queryKey: ['project-chats', projectId] })
  }

  async function ingest() {
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
      refresh()
    } finally { setIngesting(false) }
  }

  async function uploadFile(file: File) {
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
      refresh()
    } finally { setIngesting(false) }
  }

  async function search() {
    if (!workspaceId || !project || !query.trim()) return
    setSearching(true); setResults(null)
    try {
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/projects/${project.id}/search?q=${encodeURIComponent(query.trim())}`, { headers: authHeaders() })
      const d = await res.json().catch(() => ({}))
      setResults(Array.isArray(d.results) ? d.results : [])
    } catch { setResults([]) } finally { setSearching(false) }
  }

  if (missing) {
    return (
      <AppPage title="Project" documentTitle="Project" back={{ href: '/projects', label: 'Projects' }}>
        <ErrorState
          title="That project does not exist"
          message="It may have been deleted, or the link is stale."
          tone="neutral"
          actions={<Link href="/projects" className={linkCls}>Back to projects</Link>}
        />
      </AppPage>
    )
  }

  if (!project) {
    return (
      <AppPage title="Project" documentTitle="Project" back={{ href: '/projects', label: 'Projects' }}>
        <LoadingState label="Loading project" />
      </AppPage>
    )
  }

  return (
    <AppPage
      title={project.name}
      documentTitle={project.name}
      back={{ href: '/projects', label: 'Projects' }}
      meta={(
        <span>
          Your role: {project.role} · {project._count.conversations} chat{project._count.conversations === 1 ? '' : 's'} ·
          {' '}{project._count.knowledgeChunks} indexed passage{project._count.knowledgeChunks === 1 ? '' : 's'}
        </span>
      )}
      actions={(
        <Link href={`/chat?project=${encodeURIComponent(project.id)}`} className={btnSecondary}>
          <Sparkles size={14} aria-hidden /> Open in chat
        </Link>
      )}
    >
      <div className="space-y-5">
        <section aria-label="Instructions" className={`${panelCls} p-4`}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-ui-sm text-[var(--ink-secondary)]"><BookOpen size={14} className="text-[var(--ink-muted)]" aria-hidden /> Project instructions</div>
            <button
              type="button"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !dirty}
              className={`${btnSecondary} px-3 py-1.5 text-ui-xs`}
            >
              {saveMutation.isPending ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Save size={12} aria-hidden />} Save
            </button>
          </div>
          <textarea
            value={instructions}
            onChange={(e) => { setInstructions(e.target.value); setDirty(true); setSaveState('idle') }}
            aria-label="Project instructions"
            rows={4}
            maxLength={5000}
            placeholder="What should the assistant know about this project? (goals, style, constraints)"
            className={`${textareaCls} mt-2.5 text-ui-sm`}
          />
          {saveState === 'ok' && <p className="mt-1.5 text-2xs text-[var(--success)]" role="status">Saved.</p>}
          {saveState === 'error' && <p className="mt-1.5 text-2xs text-[var(--danger)]" role="alert">Could not save. Try again.</p>}
        </section>

        <section aria-label="Knowledge" className={`${panelCls} p-4`}>
          <div className="text-ui-sm text-[var(--ink-secondary)]">Project knowledge</div>
          <p className="mt-1 text-2xs leading-relaxed text-[var(--ink-muted)]">
            Everything indexed here is retrieved into the chat when this project is active.
          </p>
          <div className="mt-2.5 space-y-2">
            <textarea
              value={ingestText}
              onChange={(e) => setIngestText(e.target.value)}
              aria-label="Add text to project knowledge"
              rows={3}
              placeholder="Paste notes, specs or context to index…"
              className={`${textareaCls} text-ui-xs`}
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void ingest()}
                disabled={ingesting || !ingestText.trim()}
                className={`${btnOutline} px-3 py-1.5 text-ui-xs`}
              >
                {ingesting ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <BookOpen size={12} aria-hidden />} Add text
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={ingesting}
                className={`${btnOutline} px-3 py-1.5 text-ui-xs`}
              >
                <FileUp size={12} aria-hidden /> Upload file
              </button>
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                accept=".pdf,.docx,.xlsx,.csv,.txt,.md"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFile(f); e.target.value = '' }}
              />
              {ingestMsg && <span className={`text-2xs ${ingestMsg.startsWith('Indexed') || ingestMsg.startsWith('Added') ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`} role="status">{ingestMsg}</span>}
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
              className={`${inputCls} py-1.5 text-ui-xs`}
            />
            <button
              type="submit"
              disabled={searching || !query.trim()}
              className={`${btnOutline} px-3 py-1.5 text-ui-xs`}
            >
              {searching ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Search size={12} aria-hidden />} Search
            </button>
          </form>
          {results !== null && (
            <ul className="mt-2.5 space-y-1.5">
              {results.map((hit, i) => {
                const text = hit?.chunk?.content || hit?.content || hit?.text || ''
                return (
                  <li key={i} className={`${panelCls} px-3 py-2 text-ui-xs leading-relaxed text-[var(--ink-secondary)]`}>
                    {text.slice(0, 280)}{text.length > 280 ? '…' : ''}
                  </li>
                )
              })}
              {results.length === 0 && <li className="text-ui-xs text-[var(--ink-muted)]">Nothing matched. Add more knowledge and try again.</li>}
            </ul>
          )}
        </section>

        <section aria-label="Project chats" className={`${panelCls} p-4`}>
          <div className="text-ui-sm text-[var(--ink-secondary)]">Chats in this project</div>
          <ul className="mt-2 space-y-1.5">
            {chats.map((c) => (
              <li key={c.id}>
                <Link href={`/chat?conversation=${encodeURIComponent(c.id)}`} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-ui-sm text-[var(--ink-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)]">
                  <span className="flex min-w-0 items-center gap-2"><MessageSquare size={13} className="shrink-0 text-[var(--ink-muted)]" aria-hidden /> <span className="truncate">{c.title || 'Untitled chat'}</span></span>
                  <span className="shrink-0 text-2xs text-[var(--ink-muted)]">{timeAgo(c.updatedAt)}</span>
                </Link>
              </li>
            ))}
            {chats.length === 0 && (
              <li className="text-ui-xs text-[var(--ink-muted)]">No chats yet — open the project in chat to start one.</li>
            )}
          </ul>
        </section>
      </div>
    </AppPage>
  )
}
