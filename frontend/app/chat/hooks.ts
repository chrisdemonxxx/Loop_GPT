'use client'

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'

import { API_URL, authHeaders, getToken, type AgentMode } from '../lib/api'
import { runAgentStream, type ArtifactRef } from '../lib/stream'
import { track } from '../components/Analytics'
import type { Project } from '../components/ProjectsPanel'
import type { Conversation, Message, LiveStep, PendingApproval } from '../components/chat/types'

// ---------------------------------------------------------------------------
// Panels: sidebar / activity / artifacts + responsive desktop detection
// ---------------------------------------------------------------------------

/** Panel open/close state + the 1024px desktop media-query. The activity
 * feed is inline below each response (TurnActivity), so the right edge is
 * exclusively the artifacts panel — no shared-panel mutex remains. */
export function usePanels() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [artifactsOpen, setArtifactsOpen] = useState(false)
  const [isDesktop, setIsDesktop] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(min-width: 1024px)')
    const apply = () => { setIsDesktop(mq.matches); setSidebarOpen(mq.matches) }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  const closeOverlays = () => { if (!isDesktop) { setSidebarOpen(false); setArtifactsOpen(false) } }

  return {
    sidebarOpen, setSidebarOpen,
    artifactsOpen, setArtifactsOpen,
    isDesktop,
    closeOverlays,
  }
}

// ---------------------------------------------------------------------------
// Workspace + projects bootstrap
// ---------------------------------------------------------------------------

/** Load the personal workspace + its projects once authenticated, and keep
 * the persisted active-project selection. */
export function useWorkspaceProjects() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)

  useEffect(() => {
    if (!getToken()) return
    ;(async () => {
      try {
        await axios.post(`${API_URL}/api/workspaces/personal`, {}, { headers: authHeaders() })
        const res = await axios.get(`${API_URL}/api/workspaces`, { headers: authHeaders() })
        const ws = res.data?.workspaces || []
        const mine = ws.find((w: any) => w.personalOwnerId) || ws[0]
        if (!mine?.id) return
        setWorkspaceId(mine.id)
        const pr = await axios.get(`${API_URL}/api/workspaces/${mine.id}/projects`, { headers: authHeaders() })
        setProjects(Array.isArray(pr.data) ? pr.data : [])
        const saved = localStorage.getItem('activeProjectId')
        if (saved) setActiveProjectId(saved)
      } catch { /* not critical */ }
    })()
  }, [])

  async function refreshProjects() {
    if (!workspaceId) return
    try {
      const pr = await axios.get(`${API_URL}/api/workspaces/${workspaceId}/projects`, { headers: authHeaders() })
      setProjects(Array.isArray(pr.data) ? pr.data : [])
    } catch { /* ignore */ }
  }

  return { workspaceId, projects, setProjects, activeProjectId, setActiveProjectId, refreshProjects }
}

// ---------------------------------------------------------------------------
// Conversation + message queries
// ---------------------------------------------------------------------------

/** React-query data layer for the conversation list and the active
 * conversation's messages, plus rename/delete mutations and invalidation
 * helpers. */
export function useConversationsData(
  currentConversationId: string | null,
  onCurrentDeleted: (id: string) => void,
) {
  const queryClient = useQueryClient()

  const { data: conversations = [] } = useQuery<Conversation[]>({
    queryKey: ['conversations'],
    queryFn: async () =>
      (await axios.get(`${API_URL}/api/conversations`, { headers: authHeaders(false) }).catch(() => ({ data: [] }))).data,
    enabled: typeof window !== 'undefined',
  })

  const { data: messages = [] } = useQuery<Message[]>({
    queryKey: ['messages', currentConversationId],
    queryFn: async () => {
      if (!currentConversationId) return []
      return (await axios.get(`${API_URL}/api/conversations/${currentConversationId}/messages`, { headers: authHeaders(false) }).catch(() => ({ data: [] }))).data
    },
    enabled: !!currentConversationId && typeof window !== 'undefined',
  })

  const updateConv = useMutation({
    mutationFn: async ({ id, title }: { id: string; title: string }) =>
      (await axios.patch(`${API_URL}/api/conversations/${id}`, { title }, { headers: authHeaders() })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['conversations'] }),
  })

  const deleteConv = useMutation({
    mutationFn: async (id: string) =>
      (await axios.delete(`${API_URL}/api/conversations/${id}`, { headers: authHeaders(false) })).data,
    onSuccess: (_d, id) => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      onCurrentDeleted(id)
    },
  })

  const invalidateConversations = () => queryClient.invalidateQueries({ queryKey: ['conversations'] })
  const invalidateMessages = (id: string | null) =>
    id ? queryClient.invalidateQueries({ queryKey: ['messages', id] }) : Promise.resolve()

  return { conversations, messages, updateConv, deleteConv, invalidateConversations, invalidateMessages }
}

// ---------------------------------------------------------------------------
// The live agent run: streaming state machine + send pipeline
// ---------------------------------------------------------------------------

export interface ChatStreamSendOptions {
  /** Parsed send payload (from parseCommand). */
  content: string
  sendMode: AgentMode
  commandTools?: string[]
  /** Attachments grabbed before clearing the composer. */
  images: File[]
  docs: File[]
  previews: string[]
  /** Run configuration. */
  runMode: 'auto' | 'plan' | 'accept' | 'step'
  modelTier: string
  selectedTools?: Set<string> | null
  incognito: boolean
  projectId?: string
  /** Resolves (creating if needed) the conversation for this turn. */
  ensureConversation: (firstMessage: string) => Promise<string>
}

/** Owns everything live about an agent run: running/status, the streamed
 * steps/thinking/answer, in-run artifacts, the pending-approval handshake,
 * and the abort controller. `send()` is the full pipeline (uploads → stream
 * → invalidation) with the exact semantics the page used inline. The activity
 * timeline renders inline per turn (TurnActivity) — there is no side panel
 * to auto-open. */
export function useChatStream() {
  const [running, setRunning] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [liveUser, setLiveUser] = useState<{ content: string; image?: string; images?: string[]; docs?: string[] } | null>(null)
  const [liveSteps, setLiveSteps] = useState<LiveStep[]>([])
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const [liveArtifacts, setLiveArtifacts] = useState<ArtifactRef[]>([])
  const [liveThinking, setLiveThinking] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const queryClient = useQueryClient()

  const liveAnswer = liveSteps.filter((s) => s.kind === 'text').map((s) => s.text).join('')

  const stopRun = () => { abortRef.current?.abort(); setRunning(false) }

  /** Clear all live-turn state (conversation switch / fork). */
  const resetLive = () => {
    setLiveUser(null); setLiveSteps([]); setLiveArtifacts([]); setStatusMsg(''); setLiveThinking('')
  }

  /** Narrower reset (incognito toggle): clears the visible turn but keeps
   * status/thinking state, exactly as the original inline implementation. */
  const clearTurn = () => {
    setLiveSteps([]); setLiveArtifacts([]); setLiveUser(null)
  }

  async function uploadImage(convId: string, file: File): Promise<string | undefined> {
    const fd = new FormData()
    fd.append('image', file)
    try {
      return (await axios.post(`${API_URL}/api/conversations/${convId}/upload-image`, fd, { headers: authHeaders(false) })).data.attachmentId
    } catch { return undefined }
  }

  /** Documents (PDF/DOCX/XLSX/CSV/TXT/MD) — extracted server-side; the
   * returned attachment id inlines the text into the prompt. */
  async function uploadDocument(convId: string, file: File): Promise<string | undefined> {
    const fd = new FormData()
    fd.append('document', file)
    try {
      const res = await axios.post(`${API_URL}/api/conversations/${convId}/upload-document`, fd, { headers: authHeaders(false) })
      return res.data.attachmentId
    } catch (e: any) {
      setStatusMsg(`⚠️ ${file.name}: ${e?.response?.data?.error || 'could not read this document'}`)
      return undefined
    }
  }

  async function send(opts: ChatStreamSendOptions) {
    const { content, sendMode, commandTools, images, docs, previews, runMode, modelTier, selectedTools, incognito, projectId, ensureConversation } = opts
    setRunning(true); setStatusMsg(''); setLiveSteps([]); setLiveArtifacts([]); setLiveThinking('')
    setLiveUser({ content, image: previews[0], images: previews, docs: docs.map((d) => d.name) })
    track('message_sent', { mode: sendMode })

    let convId: string | null = null
    try {
      convId = await ensureConversation(content)
      const imageIds = (await Promise.all(images.map((f) => uploadImage(convId!, f)))).filter(Boolean) as string[]
      const docIds = (await Promise.all(docs.map((f) => uploadDocument(convId!, f)))).filter(Boolean) as string[]
      const attachmentIds = [...imageIds, ...docIds]
      const abort = new AbortController()
      abortRef.current = abort

      const sendContent = runMode === 'plan' && content
        ? `Plan first: briefly outline the steps you'll take, then carry them out.\n\n${content}`
        : content

      await runAgentStream(convId, {
        content: sendContent, attachmentIds, mode: sendMode,
        model: modelTier || undefined,
        toolNames: commandTools || (selectedTools ? Array.from(selectedTools) : undefined),
        autoApprove: runMode === 'accept',
        stepMode: runMode === 'step',
        incognito,
        projectId,
      }, {
        onStatus: (m) => { if (!m.startsWith('conversation:')) setStatusMsg(m) },
        onWarming: (m) => setStatusMsg(m),
        onDelta: (step, text) => {
          setStatusMsg('')
          setLiveSteps((prev) => {
            const next = [...prev]
            const i = next.findIndex((s) => s.index === step)
            if (i === -1) next.push({ index: step, kind: 'text', text, ts: Date.now() })
            else if (next[i].kind === 'text') next[i] = { ...next[i], text: next[i].text + text }
            return next
          })
        },
        onThinking: (step, text) => {
          setLiveThinking((prev) => (prev + text).slice(0, 20_000))
        },
        onToolCall: (step, name, args, source) => {
          setLiveSteps((prev) => {
            const next = [...prev]
            const i = next.findIndex((s) => s.index === step)
            const t: LiveStep = { index: step, kind: 'tool', text: '', ts: Date.now(), tool: { name, args, source } }
            if (i === -1) next.push(t); else next[i] = t
            return next
          })
        },
        onToolResult: (step, name, resultContent, _d, isError) => {
          setLiveSteps((prev) =>
            prev.map((s) => {
              if (s.index !== step || !s.tool) return s
              const startedAt = s.ts || Date.now()
              return { ...s, tool: { ...s.tool, result: resultContent, isError, durationMs: Date.now() - startedAt } }
            })
          )
        },
        onArtifact: (a) => setLiveArtifacts((prev) => [...prev, a]),
        onPendingApproval: (toolName, args, _prompt) => {
          // Build the approval fetch URL with the current conversation id.
          const approve = (approved: boolean) =>
            axios.post(`${API_URL}/api/agent/${convId}/approve`, { toolName, approved }, { headers: authHeaders(false) }).catch(() => undefined)
          setLiveSteps((prev) => {
            const idx = Date.now()
            const next = [...prev]
            next.push({ index: idx, kind: 'tool', text: '', tool: { name: toolName, args, source: 'approval' } })
            return next
          })
          // Store the resolve function for the approval UI to call.
          setPendingApproval({ toolName, approve })
        },
        onError: (m) => setStatusMsg(`⚠️ ${m}`),
        onFinal: () => {},
        onDone: () => {},
      }, abort.signal)
    } catch (err: any) {
      setStatusMsg(`⚠️ ${err?.message || 'Run failed'}`)
    } finally {
      setRunning(false)
      abortRef.current = null
      if (convId) await queryClient.invalidateQueries({ queryKey: ['messages', convId] })
      await queryClient.invalidateQueries({ queryKey: ['conversations'] })
      setLiveUser(null); setStatusMsg('')
    }
  }

  return {
    running, statusMsg, liveUser, liveSteps, liveArtifacts, liveThinking, liveAnswer,
    pendingApproval, setPendingApproval,
    stopRun, resetLive, clearTurn, send,
  }
}
