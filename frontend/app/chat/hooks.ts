'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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

/** Panel open/close state + responsive breakpoints. The sidebar is
 * persistent from tablet up (≥768px, audit P6), while the right panel docks
 * only on desktop (≥1024px). The activity feed is inline below each
 * response (TurnActivity), so the right edge is exclusively the artifacts
 * panel — no shared-panel mutex remains. */
export function usePanels() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [artifactsOpen, setArtifactsOpen] = useState(false)
  const [isTablet, setIsTablet] = useState(false)
  const [isDesktop, setIsDesktop] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const tabletMq = window.matchMedia('(min-width: 768px)')
    const desktopMq = window.matchMedia('(min-width: 1024px)')
    const apply = () => {
      setIsTablet(tabletMq.matches)
      setIsDesktop(desktopMq.matches)
      // The sidebar stays persistent from tablet up; below that it starts
      // closed (the layout is too narrow to share with the transcript).
      setSidebarOpen(tabletMq.matches)
    }
    apply()
    tabletMq.addEventListener('change', apply)
    desktopMq.addEventListener('change', apply)
    return () => {
      tabletMq.removeEventListener('change', apply)
      desktopMq.removeEventListener('change', apply)
    }
  }, [])

  const closeOverlays = () => { if (!isTablet) { setSidebarOpen(false); setArtifactsOpen(false) } }

  return {
    sidebarOpen, setSidebarOpen,
    artifactsOpen, setArtifactsOpen,
    isTablet,
    isDesktop,
    closeOverlays,
  }
}

/**
 * Tracks the on-screen keyboard (audit P6) via the VisualViewport API: when
 * the keyboard pushes the visual viewport up, --kb-offset receives the
 * intrusion distance so the composer's bottom padding lifts above it
 * instead of being covered (classic iOS problem).
 */
export function useKeyboardSafeBottom() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const apply = () => {
      const intrusion = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      document.documentElement.style.setProperty('--kb-offset', `${Math.round(intrusion)}px`)
    }
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      document.documentElement.style.setProperty('--kb-offset', '0px')
    }
  }, [])
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
    mutationFn: async ({ id, title, pinned }: { id: string; title?: string; pinned?: boolean }) =>
      (await axios.patch(`${API_URL}/api/conversations/${id}`, title !== undefined ? { title } : { pinned }, { headers: authHeaders() })).data,
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

export interface ConversationSearchHit {
  conversationId: string
  title: string
  updatedAt: string
  pinned: boolean
  snippet: string
  matches: number
}

/**
 * Message-body search for the sidebar (audit §8-16: search previously
 * matched titles only). Debounced; disabled below 2 characters.
 */
export function useConversationSearch(q: string) {
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(q), 250)
    return () => clearTimeout(handle)
  }, [q])
  const { data: hits = [] } = useQuery<ConversationSearchHit[]>({
    queryKey: ['conversation-search', debounced],
    queryFn: async () =>
      (await axios.get(`${API_URL}/api/conversations/search`, { params: { q: debounced }, headers: authHeaders(false) }).catch(() => ({ data: [] }))).data,
    enabled: debounced.trim().length >= 2,
  })
  return hits
}

// ---------------------------------------------------------------------------
// Attachments: upload at attach-time with progress, errors, and retry
// ---------------------------------------------------------------------------

export interface PendingAttachment {
  /** Local record id. */
  id: string
  kind: 'image' | 'doc'
  name: string
  file: File
  /** Local data-URL preview (images only). */
  previewUrl?: string
  /** 0–100 while uploading. */
  progress: number
  status: 'uploading' | 'done' | 'error'
  error?: string
  /** Server attachment id once uploaded (what the stream inlines). */
  attachmentId?: string
}

/** Max four attachments per turn (matching the stream contract). */
const MAX_ATTACHMENTS = 4

let attachmentSeq = 0

/**
 * Attach-time uploads (audit P2.7): files upload as they are attached, with
 * per-chip progress and visible errors (image failures were previously
 * silent at send time). The first upload to a fresh chat creates the
 * conversation (the upload routes accept 'new' and return its id); later
 * uploads and the eventual send reuse it.
 */
export function useAttachments(currentConversationId: string | null) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  /** Conversation created by a 'new' upload (before the first send) — kept
   *  in a ref so concurrent uploads in one batch share the target. */
  const uploadConvRef = useRef<string | null>(null)
  const [uploadConversationId, setUploadConversationId] = useState<string | null>(null)

  const patch = useCallback((id: string, fields: Partial<PendingAttachment>) =>
    setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, ...fields } : a))), [])

  const upload = useCallback(async (record: PendingAttachment, retryOf?: string) => {
    const id = retryOf || record.id
    const target = uploadConvRef.current || currentConversationId || 'new'
    const endpoint = record.kind === 'image' ? 'upload-image' : 'upload-document'
    const field = record.kind === 'image' ? 'image' : 'document'
    const fd = new FormData()
    fd.append(field, record.file)
    try {
      const res = await axios.post(`${API_URL}/api/conversations/${target}/${endpoint}`, fd, {
        headers: authHeaders(false),
        onUploadProgress: (e) => {
          if (e.total) patch(id, { progress: Math.min(99, Math.round((e.loaded / e.total) * 100)) })
        },
      })
      const { attachmentId, conversationId } = res.data as { attachmentId: string; conversationId: string }
      uploadConvRef.current = uploadConvRef.current || conversationId
      setUploadConversationId(uploadConvRef.current)
      patch(id, { progress: 100, status: 'done', attachmentId, error: undefined })
    } catch (e: any) {
      patch(id, { status: 'error', error: e?.response?.data?.error || 'Upload failed' })
    }
  }, [currentConversationId, patch])

  /** Attach files (drag-drop, paste, picker, screenshot). Caps at four
   *  total per turn; images get a local data-URL preview. */
  const addFiles = useCallback((files: File[]) => {
    const created: PendingAttachment[] = []
    setAttachments((prev) => {
      const slots = Math.max(0, MAX_ATTACHMENTS - prev.length)
      if (slots === 0) return prev
      const accepted = files
        .filter((f) => f.type.startsWith('image/') || /\.(pdf|docx|xlsx|csv|txt|md|markdown)$/i.test(f.name))
        .slice(0, slots)
      for (const file of accepted) {
        created.push({
          id: `att-${Date.now()}-${attachmentSeq++}`,
          kind: file.type.startsWith('image/') ? 'image' : 'doc',
          name: file.name,
          file,
          progress: 0,
          status: 'uploading',
        })
      }
      return [...prev, ...created]
    })
    for (const record of created) {
      void upload(record)
      if (record.kind === 'image') {
        const r = new FileReader()
        r.onloadend = () => patch(record.id, { previewUrl: r.result as string })
        r.readAsDataURL(record.file)
      }
    }
  }, [upload, patch])

  const remove = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  /** Re-run a failed upload (audit P2.7: errors are actionable, not dead ends). */
  const retry = useCallback((id: string) => {
    setAttachments((prev) => {
      const record = prev.find((a) => a.id === id)
      if (record) void upload(record, id)
      return prev.map((a) => (a.id === id ? { ...a, status: 'uploading', progress: 0, error: undefined } : a))
    })
  }, [upload])

  const reset = useCallback(() => {
    setAttachments([])
    uploadConvRef.current = null
    setUploadConversationId(null)
  }, [])

  const readyIds = attachments.filter((a) => a.status === 'done' && a.attachmentId).map((a) => a.attachmentId!)
  const uploading = attachments.some((a) => a.status === 'uploading')

  return {
    attachments, addFiles, remove, retry, reset,
    /** Conversation the uploads landed in (null until one completes). */
    uploadConversationId,
    /** Uploaded server ids, ready for the stream. */
    readyIds,
    /** True while any upload is in flight (send waits for it). */
    uploading,
  }
}

// ---------------------------------------------------------------------------
// The live agent run: streaming state machine + send pipeline
// ---------------------------------------------------------------------------

export interface ChatStreamSendOptions {
  /** Parsed send payload (from parseCommand). */
  content: string
  sendMode: AgentMode
  commandTools?: string[]
  /** Pre-uploaded attachments (attach-time upload via useAttachments): the
   *  server ids the stream inlines, plus previews/doc names for the live
   *  user bubble. */
  attachmentIds: string[]
  previews: string[]
  docNames: string[]
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
 * and the abort controller. `send()` runs the stream against attachments
 * that were uploaded at attach time (useAttachments) — no silent send-time
 * uploads remain. The activity timeline renders inline per turn
 * (TurnActivity) — there is no side panel to auto-open. */
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

  async function send(opts: ChatStreamSendOptions) {
    const { content, sendMode, commandTools, attachmentIds, previews, docNames, runMode, modelTier, selectedTools, incognito, projectId, ensureConversation } = opts
    setRunning(true); setStatusMsg(''); setLiveSteps([]); setLiveArtifacts([]); setLiveThinking('')
    setLiveUser({ content, image: previews[0], images: previews, docs: docNames })
    track('message_sent', { mode: sendMode })

    let convId: string | null = null
    try {
      convId = await ensureConversation(content)
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
