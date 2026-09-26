'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'

import { API_URL, authHeaders, getToken, type AgentMode } from '../lib/api'
import { runAgentStream, type ArtifactRef } from '../lib/stream'
import { track } from '../components/Analytics'
import { buildBranchView, type BranchVersionInfo } from '../lib/branch'
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

  // Branch envelope (§8-22): every row + the active leaf. The transcript
  // renders the DERIVED active path (buildBranchView) so retries and edits
  // become <2/3> version arrows instead of destructive rewrites.
  const { data: branch = { activeLeafId: null, messages: [] } } = useQuery<{ activeLeafId: string | null; messages: Message[] }>({
    queryKey: ['messages', currentConversationId],
    queryFn: async () => {
      if (!currentConversationId) return { activeLeafId: null, messages: [] }
      return (await axios.get(`${API_URL}/api/conversations/${currentConversationId}/messages?branch=1`, { headers: authHeaders(false) }).catch(() => ({ data: { activeLeafId: null, messages: [] } as { activeLeafId: string | null; messages: Message[] } }))).data
    },
    enabled: !!currentConversationId && typeof window !== 'undefined',
  })
  const branchView = useMemo(() => buildBranchView(branch.messages, branch.activeLeafId), [branch])

  /** Version arrows (§8-22): switching persists the new active path
   *  server-side (run context follows it), then updates the cached
   *  envelope — the client already holds every row, no refetch needed. */
  const selectVersion = useMutation({
    mutationFn: async ({ conversationId, messageId }: { conversationId: string; messageId: string }) =>
      (await axios.post(`${API_URL}/api/conversations/${conversationId}/branch-select`, { messageId }, { headers: authHeaders() })).data as { activeLeafId: string },
    onSuccess: (data, variables) => {
      queryClient.setQueryData<{ activeLeafId: string | null; messages: Message[] }>(['messages', variables.conversationId], (old) =>
        old ? { ...old, activeLeafId: data.activeLeafId } : old)
    },
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

  // `messages` is the ACTIVE PATH — every existing consumer (transcript,
  // export, context meter, retry indices) works on exactly what is displayed.
  const messages = branchView.path
  return {
    conversations, messages, updateConv, deleteConv, invalidateConversations, invalidateMessages,
    /** Version-arrow data per displayed row (§8-22). */
    branchVersions: branchView.versions as Record<string, BranchVersionInfo>,
    /** The conversation's active branch tip. */
    activeLeafId: branch.activeLeafId,
    /** Switch the active path to a version row (§8-22 arrows). */
    selectVersion,
  }
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
// Per-message queue: send while a run is active (audit §8-39)
// ---------------------------------------------------------------------------

/**
 * Queues messages sent while a run is active instead of dropping them
 * (audit §8-39 — the old send path returned early on `running` and the
 * typed message was lost). When the run completes, the next entry
 * auto-dispatches FIFO. Entries carry their full send intent as snapshotted
 * at enqueue time (mode, tools, attachments, branch parent) so drain-time
 * dispatch is exactly what the user sent.
 */
export function useMessageQueue(isRunning: boolean, dispatchNext: (entry: import('../components/chat/types').QueuedMessage) => void) {
  const [queue, setQueue] = useState<import('../components/chat/types').QueuedMessage[]>([])
  /** Last-seen running state — the drain fires only on a true→false edge. */
  const prevRunningRef = useRef(isRunning)
  /** Freshest queue for the drain effect (its dep is only `isRunning`). */
  const queueRef = useRef(queue)
  queueRef.current = queue
  /** The dispatcher may change every render; the effect must not re-fire for that. */
  const dispatchRef = useRef(dispatchNext)
  dispatchRef.current = dispatchNext

  const enqueue = useCallback((entry: import('../components/chat/types').QueuedMessage) => {
    setQueue((prev) => [...prev, entry])
  }, [])
  const remove = useCallback((id: string) => {
    setQueue((prev) => prev.filter((e) => e.id !== id))
  }, [])
  const clear = useCallback(() => setQueue([]), [])

  useEffect(() => {
    const wasRunning = prevRunningRef.current
    prevRunningRef.current = isRunning
    if (!wasRunning || isRunning) return
    // A run just completed: hand the next queued message (if any) to the
    // sender. The entry is removed before dispatch so it can never be
    // double-sent, and the updater stays pure (the ref holds the queue).
    const next = queueRef.current[0]
    if (!next) return
    setQueue((prev) => prev.filter((e) => e.id !== next.id))
    dispatchRef.current(next)
  }, [isRunning])

  return { queue, enqueue, remove, clear }
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
  /** Explicit per-run overrides (§8-25/26): undefined = server default. */
  webSearch?: boolean
  thinking?: boolean
  /** Branch anchors (§8-22): an edit re-sends as a sibling prompt under
   *  parentMessageId (explicit null = first turn); a retry re-answers the
   *  stored user row regenerateOf. Mutually exclusive on the server. */
  parentMessageId?: string | null
  regenerateOf?: string
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
  /** §8-22: while a branched run (retry/edit) streams, the transcript is
   * truncated at this row and the live turn renders in its place — the
   * Claude-style "the old version swaps out while the new one streams". */
  const [liveAnchorId, setLiveAnchorId] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  /** The active durable run's id (§8-30) — the stop button cancels it. */
  const runIdRef = useRef<string | null>(null)
  /** The conversation the active run belongs to (for the cancel POST). */
  const activeConvRef = useRef<string | null>(null)
  const queryClient = useQueryClient()

  // ── Streamed-text batching (§8-33): accumulate per-token delta/thinking
  // callbacks and flush on animation frames — the transcript re-renders (and
  // Markdown re-parses) once per frame instead of once per token. A hard
  // 250ms timeout guards background tabs where rAF stalls; terminal events
  // and the send() finally flush synchronously so nothing is ever lost.
  const pendingDeltasRef = useRef<Array<{ step: number; text: string }>>([])
  const pendingThinkingRef = useRef('')
  const flushScheduledRef = useRef(false)
  const flushLive = () => {
    flushScheduledRef.current = false
    const deltas = pendingDeltasRef.current
    const thinking = pendingThinkingRef.current
    pendingDeltasRef.current = []
    pendingThinkingRef.current = ''
    if (deltas.length === 0 && !thinking) return
    if (deltas.length) setStatusMsg('')
    if (thinking) setLiveThinking((prev) => (prev + thinking).slice(0, 20_000))
    for (const { step, text } of deltas) {
      setLiveSteps((prev) => {
        const next = [...prev]
        const i = next.findIndex((s) => s.index === step)
        if (i === -1) next.push({ index: step, kind: 'text', text, ts: Date.now() })
        else if (next[i].kind === 'text') next[i] = { ...next[i], text: next[i].text + text }
        return next
      })
    }
  }
  const scheduleFlush = () => {
    if (flushScheduledRef.current) return
    flushScheduledRef.current = true
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        flushScheduledRef.current = false
        flushLive()
      })
    }
    // Safety net: in hidden tabs rAF never fires — a hard timer bounds the
    // longest possible stall (it no-ops when rAF already flushed).
    setTimeout(() => {
      if (flushScheduledRef.current) flushLive()
    }, 250)
  }

  const liveAnswer = liveSteps.filter((s) => s.kind === 'text').map((s) => s.text).join('')

  const stopRun = () => {
    // Explicit stop cancels the durable run server-side (§8-30): a dropped
    // connection never aborts it anymore, so the stop button must.
    const runId = runIdRef.current
    abortRef.current?.abort()
    setRunning(false)
    if (runId) {
      fetch(`${API_URL}/api/agent/${activeConvRef.current || ''}/runs/${runId}/cancel`, {
        method: 'POST',
        headers: authHeaders(),
        keepalive: true,
      }).catch(() => { /* fire-and-forget: the sweeper reaps the run regardless */ })
    }
  }

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
    const { content, sendMode, commandTools, attachmentIds, previews, docNames, runMode, modelTier, selectedTools, incognito, projectId, webSearch, thinking, parentMessageId, regenerateOf, ensureConversation } = opts
    setRunning(true); setStatusMsg(''); setLiveSteps([]); setLiveArtifacts([]); setLiveThinking('')
    runIdRef.current = null
    // §8-22: a retry anchors under the re-answered user row; an edit under
    // the edited prompt's predecessor; a normal send appends (no truncation).
    setLiveAnchorId(regenerateOf ?? (parentMessageId !== undefined ? parentMessageId : null))
    setLiveUser({ content, image: previews[0], images: previews, docs: docNames })
    track('message_sent', { mode: sendMode })

    let convId: string | null = null
    try {
      convId = await ensureConversation(content)
      activeConvRef.current = convId
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
        // Explicit capability overrides — only present when chosen (§8-25/26).
        ...(webSearch !== undefined ? { webSearch } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
        // Branch anchoring (§8-22) — only present when retrying/editing.
        ...(parentMessageId !== undefined ? { parentMessageId } : {}),
        ...(regenerateOf ? { regenerateOf } : {}),
      }, {
        onStatus: (m) => { if (!m.startsWith('conversation:')) setStatusMsg(m) },
        onWarming: (m) => setStatusMsg(m),
        // The durable run id — the stop button's cancel target (§8-30).
        onRun: (id) => { runIdRef.current = id },
        // Batched per frame (§8-33): per-token callbacks only buffer; the
        // flush applies them in one state update (see flushLive/scheduleFlush).
        onDelta: (step, text) => {
          pendingDeltasRef.current.push({ step, text })
          scheduleFlush()
        },
        onThinking: (_step, text) => {
          pendingThinkingRef.current = (pendingThinkingRef.current + text).slice(0, 20_000)
          scheduleFlush()
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
        // Live stdout/stderr (§8-28): append to the step's bounded display buffer.
        onToolOutput: (step, chunk, stream) => {
          setLiveSteps((prev) => prev.map((s) => {
            if (s.index !== step || !s.tool) return s
            const live = s.tool.liveOutput || { stdout: '', stderr: '' }
            const key = stream === 'stderr' ? 'stderr' : 'stdout'
            live[key] = (live[key] + chunk).slice(-8_000) // bounded: keep the tail
            return { ...s, tool: { ...s.tool, liveOutput: live } }
          }))
        },
        // Progress checklist (§8-29): the latest event for the step wins.
        onProgress: (step, items) => {
          setLiveSteps((prev) => prev.map((s) =>
            s.index === step && s.tool ? { ...s, tool: { ...s.tool, progress: items } } : s))
        },
        onToolResult: (step, name, resultContent, data, isError) => {
          setLiveSteps((prev) =>
            prev.map((s) => {
              if (s.index !== step || !s.tool) return s
              const startedAt = s.ts || Date.now()
              // Per-step artifact attribution (§8-28): names from the result data.
              const artifactNames = Array.isArray(data?.artifacts) ? data.artifacts.map((a: any) => a.name) : s.tool.artifacts
              return { ...s, tool: { ...s.tool, result: resultContent, isError, durationMs: Date.now() - startedAt, artifacts: artifactNames } }
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
        onError: (m) => {
          setStatusMsg(`⚠️ ${m}`)
          // A lost connection (§8-30) means the run may still complete in the
          // background — one delayed refresh picks up the persisted result.
          if (/Connection lost/i.test(m) && convId) {
            setTimeout(() => {
              queryClient.invalidateQueries({ queryKey: ['messages', convId] })
              queryClient.invalidateQueries({ queryKey: ['conversations'] })
            }, 45_000)
          }
        },
        onFinal: () => {},
        onDone: () => {},
      }, abort.signal)
    } catch (err: any) {
      setStatusMsg(`⚠️ ${err?.message || 'Run failed'}`)
    } finally {
      // Drain any buffered streamed text synchronously (§8-33) — nothing
      // buffered is ever lost, even if rAF never fired (background tab).
      flushLive()
      setRunning(false)
      abortRef.current = null
      if (convId) await queryClient.invalidateQueries({ queryKey: ['messages', convId] })
      await queryClient.invalidateQueries({ queryKey: ['conversations'] })
      setLiveUser(null); setStatusMsg(''); setLiveAnchorId(null)
    }
  }

  return {
    running, statusMsg, liveUser, liveSteps, liveArtifacts, liveThinking, liveAnswer,
    pendingApproval, setPendingApproval, liveAnchorId,
    stopRun, resetLive, clearTurn, send,
  }
}
