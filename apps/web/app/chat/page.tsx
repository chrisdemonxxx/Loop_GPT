'use client'

import { useState, useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import axios from 'axios'

import { API_URL, authHeaders, getStoredUser, hasSession, logoutSession, getModelTier, setModelTier, type AgentMode } from '../lib/api'
import { pushSettingsHash, readCurrentSettingsHash } from '../lib/settingsHash'
import type { EffortValue } from '../components/chat/composer/EffortSelector'
import { getDraft, setDraft, deleteDraft } from '../lib/drafts'
import { useHotkey } from '../lib/useHotkey'
import { useMenuDismiss } from '../lib/useMenuDismiss'
import SettingsPanel from '../components/SettingsPanel'
import { CommandPalette, openSidebarSearch } from '../components/CommandPalette'
import { ShortcutSheet } from '../components/ShortcutSheet'

import Sidebar from '../components/chat/Sidebar'
import Composer from '../components/chat/Composer'
import MessageList from '../components/chat/MessageList'
import ArtifactsPanel from '../components/chat/ArtifactsPanel'
import ChatHeader from '../components/chat/ChatHeader'
import { CanvasPanel } from '../components/chat/CanvasPanel'
import { BotProfilePanel, CreateBotDialog, CreateGroupDialog, StartChatPicker } from '../components/chat/BotChrome'
import { canvasFromStored, canvasFromTurn } from '../lib/canvasDoc'
import { botsForMessage, createBotGroup, createNamedBot, followUpTargets, groupFanOut, listNamedBots, openBotThread, updateNamedBot, type BotGroup, type NamedBot } from '../lib/namedBots'
import AuthSidePanel from '../components/chat/AuthSidePanel'
import type { Conversation, Message } from '../components/chat/types'
import { parseCommand, SLASH_COMMANDS } from '../lib/commands'
import ProjectsPanel, { type Project } from '../components/ProjectsPanel'
import ResearchPanel from '../components/ResearchPanel'
import { useConversationQuery } from './conversationSelection'
import { usePanels, useSidebarWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX, useWorkspaceProjects, useConversationsData, useChatStream, useKeyboardSafeBottom, useAttachments, useConversationSearch, useMessageQueue, useWorkspaceConnections, useVoiceMode } from './hooks'
import { useToast } from '../lib/toast'
import { useTheme } from '../lib/theme'
import { useSpeech } from '../lib/voice'
import type { QueuedMessage } from '../components/chat/types'

// slash commands live in ../lib/commands (registry + parseCommand)

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (ch) => (
    ch === '&' ? '&amp;'
      : ch === '<' ? '&lt;'
        : ch === '>' ? '&gt;'
          : ch === '"' ? '&quot;'
            : '&#39;'
  ))
}

/** The chat workspace: sidebar, header, transcript, composer, and the
 * activity/artifacts overlays. All run mechanics live in ./hooks; presenters
 * live in ../components/chat. */
export default function ChatPage() {
  // â”€â”€ Panels (sidebar / artifacts + tablet/desktop breakpoints) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const panels = usePanels()
  const sidebarWidth = useSidebarWidth()
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const cycleConversationRef = useRef<(dir: -1 | 1) => void>(() => {})

  // S4: the ShortcutSheet advertises ⌘L (new conversation) and ⌘B (toggle
  // sidebar) — these were listed but never bound. Same registry, now real.
  useHotkey({ key: 'l', meta: true }, () => { selectConversation(null); panels.setSidebarOpen(false) })
  useHotkey({ key: 'b', meta: true }, () => panels.setSidebarOpen((open: boolean) => !open))
  useHotkey({ key: 'ArrowUp', meta: true }, () => cycleConversationRef.current(-1))
  useHotkey({ key: 'ArrowDown', meta: true }, () => cycleConversationRef.current(1))
  // Lifts the composer above the on-screen keyboard (iOS, audit P6).
  useKeyboardSafeBottom()

  // â”€â”€ Session / UI state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null)
  useConversationQuery(currentConversationId, setCurrentConversationId)
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<AgentMode>('agent')
  const [showSlash, setShowSlash] = useState(false)
  const [showPlus, setShowPlus] = useState(false)
  // Composer menus dismiss (P0: menus leaked open — stacked popovers, no
  // click-away, Escape did nothing until reload).
  const slashBoundaryRef = useRef<HTMLDivElement>(null)
  useMenuDismiss(slashBoundaryRef, showSlash, () => setShowSlash(false))
  const [runMode, setRunMode] = useState<'auto' | 'plan' | 'accept' | 'step'>('auto')
  // â”€â”€ Per-run capability toggles (Â§8-25/26): auto = server default.
  const [webSearch, setWebSearch] = useState<'auto' | 'on' | 'off'>('auto')
  // Effort union (contract Â§A): auto/low/medium/high/xhigh/off —
  // the 6-way selector that replaced the tri-state Brain toggle.
  const [thinking, setThinking] = useState<EffortValue>('auto')
  const [incognito, setIncognito] = useState(false)
  const [modelTier, setModelTierState] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined)
  // S2: `#settings/*` opens/closes the dialog — every open path pushes the
  // hash (contract team/CONTRACT_S2_SETTINGS.md Â§2), so back/forward walks
  // panels and a deep link works from any bookmark.
  useEffect(() => {
    const onHash = () => {
      const route = readCurrentSettingsHash()
      if (route) { setShowSettings(true); setSettingsTab(route.panel) }
      else setShowSettings(false)
    }
    // popstate covers back/forward between pushState entries (our tab pushes);
    // hashchange covers typed/anchor navigation. Handler is idempotent.
    window.addEventListener('hashchange', onHash)
    window.addEventListener('popstate', onHash)
    if (readCurrentSettingsHash()) onHash()
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('popstate', onHash)
    }
  }, [])
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [researchOpen, setResearchOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [toolCount, setToolCount] = useState(0)
  /** Artifact panel focus (P2): set by artifact-card clicks; the panel opens
   * focused and "Back to list" clears it while staying open. */
  const [focusedArtifactId, setFocusedArtifactId] = useState<string | null>(null)

  // â”€â”€ Attachments: uploaded at attach-time with progress + visible errors
  //    (audit P2.7); the send consumes the ready server ids.
  const uploads = useAttachments(currentConversationId)
  /** Per-chat tool selection (null = all tools, the server default). */
  const [selectedTools, setSelectedTools] = useState<Set<string> | null>(null)

  // â”€â”€ Data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const { workspaceId, projects, activeProjectId, setActiveProjectId, refreshProjects } = useWorkspaceProjects()
  const { conversations, messages, updateConv, deleteConv, invalidateConversations, invalidateMessages, branchVersions, selectVersion, sessionsError, sessionsPending, retrySessions, messagesError, retryMessages } =
    useConversationsData(currentConversationId, (id) => { if (currentConversationId === id) setCurrentConversationId(null) })
  const chat = useChatStream()
  /** Live UI belongs to one conversation. Another chat must not show it or
   *  treat its composer as busy. */
  const streamHere = !chat.liveConversationId || chat.liveConversationId === currentConversationId
  const showRunning = chat.running && streamHere
  const viewedRef = useRef<string | null>(currentConversationId)
  // Â§8-40: workspace-connection chips — recent-use-first, pin for next run.
  const workspaceConnections = useWorkspaceConnections(workspaceId)
  // (S4) Reload reattach: if a durable run was interrupted by a reload, resume
  // it into the live UI (replay + live attach) instead of losing the turn.
  const reattachRef = useRef(chat.reattach)
  reattachRef.current = chat.reattach
  const noteViewedRef = useRef(chat.noteViewed)
  noteViewedRef.current = chat.noteViewed
  useEffect(() => {
    viewedRef.current = currentConversationId
    noteViewedRef.current(currentConversationId)
    if (!currentConversationId) return
    void reattachRef.current(currentConversationId)
  }, [currentConversationId])

  // Response-completions notification (General tab toggle): on the running →
  // idle edge, fire through the quiet-hours gate; toast when the browser
  // denies notifications (same fallback as the break engine).
  const wasRunningRef = useRef(false)
  useEffect(() => {
    const was = wasRunningRef.current
    wasRunningRef.current = chat.running
    if (!was || chat.running) return
    if (chat.takeParked()) return
    void (async () => {
      const { getPrefs } = await import('../lib/prefs')
      const prefs = getPrefs()
      if (!prefs.notifications) return
      const { notify } = await import('../lib/reminders')
      const result = await notify(prefs.quietHours, 'Loop GPT finished', 'Your answer is ready.')
      if (result === 'denied' || result === 'unsupported') toast.push('info', 'Your answer is ready.')
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.running])
  /** Freshest live steps for post-run bookkeeping (the hook object in a
   *  closure goes stale across an await; the ref never does). */
  const liveStepsRef = useRef(chat.liveSteps)
  liveStepsRef.current = chat.liveSteps
  // Â§8-44 hands-free voice mode: speak each answer, re-listen, auto-send.
  const autoSpeech = useSpeech()
  const voiceMode = useVoiceMode({
    running: showRunning,
    answer: streamHere ? chat.liveAnswer : '',
    speak: (text) => autoSpeech.speak('voice-mode', text),
    stopSpeech: autoSpeech.stop,
    speakingId: autoSpeech.speakingId,
    onAutoSend: (text) => {
      setInput(text)
      // Pass the transcript in. handleSend's `input` state is still the
      // previous render until React commits setInput.
      void handleSend(undefined, text)
    },
  })
  // Â§8-39: messages sent while a run is active queue up instead of being
  // dropped; the drain fires on every run completion (FIFO).
  const toast = useToast()
  const messageQueue = useMessageQueue(showRunning, (entry) => { void dispatchSend(entry) })
  // â”€â”€ Sidebar search: title filter locally + server-side message-body hits
  const [sidebarSearch, setSidebarSearch] = useState('')
  const { hits: messageHits, error: searchError, retry: retrySearch } = useConversationSearch(sidebarSearch)
  /** Â§8-22 pending branch edit: when set (string | null), the NEXT send
   * becomes a sibling prompt version under this parent (null = first turn).
   * undefined = a normal send. Set by the Edit action, cleared by send,
   * conversation switch, or the banner's cancel. */
  const [pendingBranch, setPendingBranch] = useState<string | null | undefined>(undefined)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const editSnapshot = useRef<{ value: string; start: number; end: number } | null>(null)
  const redoEdit = useRef<{ value: string; start: number; end: number; parent: string | null; messageId: string } | null>(null)
  const promptHistory = useRef<string[]>([])
  const histCursor = useRef(0)
  const [roster, setRoster] = useState<{ bots: NamedBot[]; groups: BotGroup[] }>({ bots: [], groups: [] })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [createBotOpen, setCreateBotOpen] = useState(false)
  const [createGroupOpen, setCreateGroupOpen] = useState(false)
  const [botBusy, setBotBusy] = useState(false)
  const [canvasDismissed, setCanvasDismissed] = useState(false)
  const [streamingBotId, setStreamingBotId] = useState<string | null>(null)
  const [openedBotId, setOpenedBotId] = useState<string | null>(null)
  const [threadMeta, setThreadMeta] = useState<{ id: string; kind: string; botId?: string | null; botIds?: string[] } | null>(null)

  useEffect(() => {
    fetch(`${API_URL}/api/agent/tools`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((t) => setToolCount(t.length || 0))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const saved = getModelTier()
    if (saved) { setModelTierState(saved); return }
    // Default to the flagship Looper.
    setModelTier('loop-large'); setModelTierState('loop-large')
  }, [])

  // Side-anchored sign-in: unauthenticated visitors land IN the chat workspace
  // with the login/signup panel docked beside it — never routed to a login page.
  const [authPanelOpen, setAuthPanelOpen] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (getStoredUser() || hasSession()) return
    fetch(`${API_URL}/api/auth/providers`)
      .then((r) => r.json())
      .then((d) => { if (!d.guest) setAuthPanelOpen(true) })
      .catch(() => {})
  }, [])

  // â”€â”€ Conversation helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function selectConversation(id: string | null) {
    viewedRef.current = id
    chat.noteViewed(id)
    // Drafts (Â§2.5): stash the in-progress text for the outgoing chat, then
    // restore whatever was in progress for the incoming one.
    if (typeof window !== 'undefined') {
      const prevKey = `draft:${currentConversationId || 'new'}`
      const nextKey = `draft:${id || 'new'}`
      if (input.trim()) setDraft(prevKey, input)
      else deleteDraft(prevKey)
      getDraft(nextKey).then((saved) => { if (saved && typeof saved === 'string') setInput(saved) })
    }
    setCurrentConversationId(id)
    setPendingBranch(undefined)
    setEditingMessageId(null)
    editSnapshot.current = null
    setCanvasDismissed(false)
    setOpenedBotId(null)
    setThreadMeta(null)
    // Â§8-39: queued messages belong to the conversation they were typed in.
    messageQueue.clear()
    if (chat.running && chat.liveConversationId !== id) chat.parkRun()
    else if (chat.liveConversationId !== id) chat.resetLive()
    panels.setArtifactsOpen(false)
  }

  // â”€â”€ Message branching (audit Â§8-22) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /** Version arrows: switch the active path to a sibling version row. The
   * server resolves + persists the new active leaf (run context follows);
   * the cached envelope updates, so the derived transcript re-renders. */
  function selectVersionRow(conversationId: string | null, messageId?: string) {
    if (!conversationId || !messageId) return
    selectVersion.mutate({ conversationId, messageId })
  }

  /** Re-answer a stored turn WITHOUT destroying the old answer (Â§8-22): the
   * new response becomes a sibling — <2/3> arrows flip between versions.
   * Text turns re-run immediately with the stored prompt; image/document
   * turns fall back to the composer (the send then branches under the same
   * parent). `beforeIndex` is a transcript index (the assistant row, or the
   * row above a user row). */
  function retryBefore(index: number) {
    const pathMsgs = messages as Message[]
    let userIdx = index >= pathMsgs.length ? pathMsgs.length - 1 : index
    if (pathMsgs[userIdx]?.role === 'assistant') userIdx--
    while (userIdx >= 0 && pathMsgs[userIdx]?.role !== 'user') userIdx--
    const userMsg = pathMsgs[userIdx]
    if (!userMsg) return
    if (!currentConversationId || showRunning) return
    if (userMsg.messageType && userMsg.messageType !== 'text') {
      // Image turns can't be replayed from the stored row (their attachments
      // live in the private store): edit-resend creates the version.
      setPendingBranch(userMsg.parentId ?? null)
      setInput(userMsg.content)
      requestAnimationFrame(() => document.querySelector('textarea')?.focus())
      return
    }
    const sendMode = (['chat', 'agent', 'research'].includes(String(userMsg.toolUsed)) ? userMsg.toolUsed : 'agent') as import('../lib/api').AgentMode
    void chat.send({
      content: userMsg.content, sendMode,
      attachmentIds: [], previews: [], docNames: [],
      runMode, modelTier, selectedTools: null, incognito,
      projectId: activeProjectId || undefined,
      regenerateOf: userMsg.id,
      ensureConversation: async () => currentConversationId!,
    }).then(() => invalidateConversations())
  }

  /** Edit a prompt in place (Â§8-22): the composer loads the stored text and
   * the NEXT send becomes a sibling version under the same parent — the old
   * prompt + answer stay reachable through the arrows. */
  function editMessageAt(messageId: string, content: string) {
    const row = (messages as Message[]).find((m) => m.id === messageId)
    const ta = document.querySelector('textarea') as HTMLTextAreaElement | null
    editSnapshot.current = { value: input, start: ta?.selectionStart ?? input.length, end: ta?.selectionEnd ?? input.length }
    redoEdit.current = null
    setEditingMessageId(messageId)
    setPendingBranch(row ? (row.parentId ?? null) : null)
    setInput(content)
    requestAnimationFrame(() => {
      const next = document.querySelector('textarea') as HTMLTextAreaElement | null
      next?.focus()
      const end = content.length
      next?.setSelectionRange(end, end)
    })
  }

  function restoreComposer(value: string, start: number, end: number) {
    setInput(value)
    requestAnimationFrame(() => {
      const ta = document.querySelector('textarea') as HTMLTextAreaElement | null
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(start, end)
    })
  }

  function cancelEdit() {
    if (pendingBranch === undefined) return
    const snap = editSnapshot.current
    if (editingMessageId) {
      const ta = document.querySelector('textarea') as HTMLTextAreaElement | null
      redoEdit.current = {
        value: input,
        start: ta?.selectionStart ?? input.length,
        end: ta?.selectionEnd ?? input.length,
        parent: pendingBranch ?? null,
        messageId: editingMessageId,
      }
    }
    setPendingBranch(undefined)
    setEditingMessageId(null)
    editSnapshot.current = null
    if (snap) restoreComposer(snap.value, snap.start, snap.end)
  }

  function undoEdit() {
    if (pendingBranch === undefined) return false
    cancelEdit()
    return true
  }

  function redoEditAction() {
    const redo = redoEdit.current
    if (!redo || pendingBranch !== undefined) return false
    const ta = document.querySelector('textarea') as HTMLTextAreaElement | null
    editSnapshot.current = { value: input, start: ta?.selectionStart ?? 0, end: ta?.selectionEnd ?? 0 }
    setPendingBranch(redo.parent)
    setEditingMessageId(redo.messageId)
    redoEdit.current = null
    restoreComposer(redo.value, redo.start, redo.end)
    return true
  }

  // â”€â”€ Composer / send â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  /** Attach files (picker, screenshot, drag-drop, paste): the useAttachments
   *  hook uploads immediately with per-chip progress and visible errors. */
  function handleImagesSelected(files: File[]) {
    uploads.addFiles(files)
  }

  function handleInputChange(value: string) {
    setInput(value)
    setShowSlash(value.startsWith('/') && !/\s/.test(value))
  }

  /** The conversation this send targets: an explicit selection, else the one
   *  attach-time uploads created ('new' uploads mint it before the first
   *  message), else a fresh one. */
  function conversationForSend(): string | null {
    return currentConversationId || uploads.uploadConversationId || null
  }

  async function ensureConversation(firstMessage: string): Promise<string> {
    const existing = conversationForSend()
    if (existing) {
      if (!currentConversationId && existing === uploads.uploadConversationId) setCurrentConversationId(existing)
      return existing
    }
    const res = await axios.post(
      `${API_URL}/api/conversations`,
      { title: firstMessage.slice(0, 50) || 'New Chat' },
      { headers: authHeaders() }
    )
    const createdId = String(res.data.id || '')
    // Don't yank the user back if they switched chats while this was creating.
    if (viewedRef.current == null) setCurrentConversationId(createdId)
    invalidateConversations()
    return createdId
  }

  /** The actual dispatch: one run, from either the composer or the queue
   *  drain (Â§8-39). `snapshot` carries the full send intent as captured at
   *  enqueue/send time — the run config it was sent with, not whatever the
   *  toggles say now. */
  async function dispatchSend(snapshot: QueuedMessage) {
    setMode(snapshot.sendMode)
    setStreamingBotId(snapshot.botId || null)
    setShowSlash(false); setShowPlus(false)
    // Surface deep-research runs in the side panel so the user can watch
    // progress and read the cited report instead of it living only in chat.
    if (snapshot.sendMode === 'research') setResearchOpen(true)
    if (typeof window !== 'undefined') deleteDraft(`draft:${currentConversationId || 'new'}`)

    // Â§8-40: a pinned connection joins agent runs. workspaceId rides ONLY a
    // NEW conversation (existing conversations resolve their own workspace
    // server-side; sending a mismatched one would 409 the run).
    const pinnedForRun = snapshot.connectionIds?.length ? snapshot.connectionIds : undefined
    const newConversation = !conversationForSend()

    await chat.send({
      content: snapshot.content, sendMode: snapshot.sendMode, commandTools: snapshot.commandTools,
      attachmentIds: snapshot.attachmentIds, previews: snapshot.previews, docNames: snapshot.docNames,
      runMode: snapshot.runMode, modelTier: snapshot.modelTier,
      selectedTools: snapshot.selectedTools, incognito: snapshot.incognito,
      projectId: snapshot.projectId,
      // Explicit overrides only (Â§8-25/26): undefined keeps the server default.
      webSearch: snapshot.webSearch === 'auto' ? undefined : snapshot.webSearch === 'on',
      // Effort union (contract Â§A): autoâ†’undefined, offâ†’false,
      // low..xhigh pass through; 'medium'â†’true keeps legacy clients 200ing
      // (the old tri-state's 'on').
      thinking: snapshot.thinking === 'auto' ? undefined
        : snapshot.thinking === 'medium' ? true
        : snapshot.thinking === 'off' ? false
        : snapshot.thinking,
      ...(snapshot.branchParent !== undefined ? { parentMessageId: snapshot.branchParent } : {}),
      ...(pinnedForRun ? { connectionIds: pinnedForRun } : {}),
      ...(pinnedForRun && newConversation && workspaceId ? { workspaceId } : {}),
      ...(snapshot.botId ? { botId: snapshot.botId } : {}),
      ...(snapshot.skipUserPersist ? { skipUserPersist: true } : {}),
      ensureConversation,
    })

    // Â§8-40: remember which connections this run actually used (their tools
    // carry source "connection:<id>") so the chip row orders by recent use.
    const used = new Set<string>()
    for (const s of liveStepsRef.current) {
      const source = s.kind === 'tool' ? s.tool?.source : undefined
      if (source?.startsWith('connection:')) used.add(source.slice('connection:'.length))
    }
    if (used.size) workspaceConnections.markUsed([...used])
  }

  async function handleSend(e?: React.FormEvent, overrideText?: string) {
    e?.preventDefault()
    const source = overrideText !== undefined ? overrideText : input
    const hasAttachments = uploads.attachments.length > 0
    if (!source.trim() && !hasAttachments) return
    // While a chip is still uploading, wait — its id is what the stream
    // inlines; sending early would silently drop the attachment.
    if (uploads.uploading) return

    // /bot <goal> — hand the goal to a Loop Bot (autonomous task) instead of
    // running a chat turn. The bot's result lands in the Loop Bot
    // conversation; its live trace opens from /agents.
    const botMatch = source.trim().match(/^\/bot\b[ \t]*/i)
    if (botMatch) {
      const goal = source.trim().slice(botMatch[0].length)
      if (!goal) { setInput('/bot '); return }
      setInput('')
      uploads.reset()
      if (typeof window !== 'undefined') deleteDraft(`draft:${currentConversationId || 'new'}`)
      try {
        const { enqueueBotTask } = await import('../lib/bot')
        await enqueueBotTask({ goal })
        toast.push('success', 'Loop Bot is on it — open Loop Bot in the sidebar to watch')
      } catch (err: any) {
        toast.push('error', err?.message || 'Could not start the Loop Bot')
      }
      return
    }

    const { mode: sendMode, text: content, tools: commandTools } = parseCommand(source.trim())
    if (!content && !hasAttachments) return
    const remembered = content.trim()
    if (remembered) {
      const hist = promptHistory.current
      if (hist[hist.length - 1] !== remembered) hist.push(remembered)
      if (hist.length > 50) hist.shift()
      histCursor.current = hist.length
    }
    // Only fully-uploaded attachments ride the send; failed ones stay as
    // visible error chips the user can retry or remove.
    const readyIds = uploads.readyIds
    const previews = uploads.attachments.filter((a) => a.kind === 'image' && a.previewUrl).map((a) => a.previewUrl!)
    const docNames = uploads.attachments.filter((a) => a.kind === 'doc' && a.status === 'done').map((a) => a.name)
    // Â§8-22: an edit-in-flight re-sends as a sibling version under the
    // remembered parent; the intent is consumed by this send.
    const branchParent = pendingBranch
    setPendingBranch(undefined)

    // Â§8-39: while a run is active the message is QUEUED (full intent
    // snapshotted), not dropped — it auto-sends when the run completes.
    // Â§8-40: the pinned connection (agent runs only) rides the snapshot.
    const connectionIds = workspaceConnections.pinnedId && sendMode === 'agent' ? [workspaceConnections.pinnedId] : undefined
    const listedConv = (conversations as Conversation[]).find((c) => c.id === currentConversationId)
    const activeConv = listedConv?.kind && listedConv.kind !== 'chat'
      ? listedConv
      : threadMeta?.id === currentConversationId
        ? { ...listedConv, id: currentConversationId, kind: threadMeta.kind, botId: threadMeta.botId, botIds: threadMeta.botIds } as Conversation
        : listedConv
    const memberIds = Array.isArray(activeConv?.botIds) ? activeConv!.botIds! : []
    const roomMembers = roster.bots.filter((b) => memberIds.includes(b.id))
    const groupTargets = activeConv?.kind === 'group' ? botsForMessage(content, roomMembers) : []
    const singleBotId = activeConv?.kind === 'bot' ? activeConv.botId || undefined : undefined
    const baseSnap = {
      content, sendMode, commandTools,
      attachmentIds: readyIds, previews, docNames,
      runMode, modelTier, selectedTools, incognito,
      projectId: activeProjectId || undefined,
      webSearch, thinking,
      ...(connectionIds ? { connectionIds } : {}),
      ...(branchParent !== undefined ? { branchParent } : {}),
    }
    if (activeConv?.kind === 'group') {
      if (!groupTargets.length) {
        toast.push('error', 'No bot in this group has that name.')
        return
      }
      const snaps = groupFanOut(groupTargets).map((bot, i) => ({
        ...baseSnap,
        id: `group-${bot.id}-${Date.now()}-${i}`,
        botId: bot.id,
        skipUserPersist: bot.skipUserPersist,
      }))
      setInput('')
      uploads.reset()
      setPendingBranch(undefined)
      setEditingMessageId(null)
      if (typeof window !== 'undefined') deleteDraft(`draft:${currentConversationId || 'new'}`)
    if (showRunning) {
      snaps.forEach((snap) => messageQueue.enqueue(snap))
        toast.push('info', 'Added to queue — it sends when the current run finishes')
        return
      }
      const replies: string[] = []
      for (const snap of snaps) {
        await dispatchSend(snap)
        const text = liveStepsRef.current.filter((s) => s.kind === 'text').map((s) => s.text).join('\n')
        if (text.trim()) replies.push(text)
      }
      const follow = followUpTargets(replies.join('\n'), roomMembers, groupTargets.map((bot) => bot.id))
      for (const bot of follow) {
        await dispatchSend({
          id: `follow-${bot.id}-${Date.now()}`,
          ...baseSnap,
          botId: bot.id,
          skipUserPersist: true,
        })
      }
      return
    }
    if (showRunning) {
      messageQueue.enqueue({
        id: `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ...baseSnap,
        ...(singleBotId ? { botId: singleBotId } : {}),
      })
      setInput('')
      uploads.reset()
      setPendingBranch(undefined)
      setEditingMessageId(null)
      if (typeof window !== 'undefined') deleteDraft(`draft:${currentConversationId || 'new'}`)
      toast.push('info', 'Added to queue — it sends when the current run finishes')
      return
    }

    setInput('')
    uploads.reset()
    setEditingMessageId(null)
    if (typeof window !== 'undefined') deleteDraft(`draft:${currentConversationId || 'new'}`)
    await dispatchSend({
      id: 'direct',
      ...baseSnap,
      ...(singleBotId ? { botId: singleBotId } : {}),
    })
  }

  function walkPromptHistory(dir: -1 | 1): string | null {
    const hist = promptHistory.current
    if (!hist.length) return null
    if (dir < 0) histCursor.current = Math.max(0, histCursor.current - 1)
    else histCursor.current = Math.min(hist.length, histCursor.current + 1)
    if (histCursor.current >= hist.length) return ''
    return hist[histCursor.current] ?? null
  }

  /** Mint + copy a public read-only share link (audit Â§8-15). */
  async function handleShareConversation(id: string): Promise<string | { error: 'share' | 'copy' }> {
    let link = ''
    try {
      const res = await axios.post(`${API_URL}/api/conversations/${id}/share`, {}, { headers: authHeaders() })
      if (!res.data?.url) return { error: 'share' }
      link = `${window.location.origin}${res.data.url}`
    } catch { return { error: 'share' } }
    try {
      if (!navigator.clipboard?.writeText) return { error: 'copy' }
      await navigator.clipboard.writeText(link)
      return link
    } catch { return { error: 'copy' } }
  }

  // -- Export / slash dispatch ---------------------------------------------
  function exportConversation(format: 'md' | 'pdf' = 'md') {
    const title = (conversations as Conversation[]).find((c) => c.id === currentConversationId)?.title || 'conversation'
    const md = (messages as Message[]).map((m) => `**${m.role === 'user' ? 'You' : 'Loop GPT'}**\n\n${m.content}`).join('\n\n---\n\n')
    if (format === 'pdf') {
      // Print-to-PDF: a clean transcript stylesheet + the browser print dialog.
      // Title and body are escaped — a chat named `<script>` must not run.
      const w = window.open('', '_blank', 'width=800,height=900')
      if (!w) return
      const safeTitle = escapeHtml(title)
      w.document.write(`<!doctype html><html><head><title>${safeTitle}</title><style>
        body{font:13px/1.65 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1e;max-width:720px;margin:32px auto;padding:0 24px}
        h1{font-size:22px;margin-bottom:4px} .meta{color:#888;font-size:12px;margin-bottom:28px}
        .msg{margin:18px 0;padding:14px;border-left:3px solid #c96442;background:#faf9f8;border-radius:6px;white-space:pre-wrap;word-break:break-word}
        .user{border-left-color:#1a1a1e;background:#f4f4f5} .who{font-weight:600;font-size:12px;color:#777;margin-bottom:6px}
      </style></head><body><h1>${safeTitle}</h1><div class="meta">Loop GPT transcript · ${escapeHtml(new Date().toLocaleString())}</div>
      ${messages.map((m) => `<div class="msg ${m.role === 'user' ? 'user' : ''}"><div class="who">${m.role === 'user' ? 'You' : 'Loop GPT'}</div>${escapeHtml(m.content || '')}</div>`).join('')}
      </body></html>`)
      w.document.close()
      w.focus()
      setTimeout(() => w.print(), 250)
      return
    }
    const blob = new Blob([`# ${title}\n\n${md}`], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${title.replace(/[^a-z0-9]/gi, '-')}.md`; a.click()
    URL.revokeObjectURL(url)
  }

  /** Slash-command dispatch (Claude/Copilot-style). Mode commands insert the
   * command text; action commands run immediately. */
  function handleSlashCommand(cmd: string) {
    setShowSlash(false)
    const def = SLASH_COMMANDS.find((d) => d.cmd === cmd.trim())
    if (!def) { setInput(cmd); return }
    if (def.kind === 'mode') { setInput(def.cmd + ' '); return }
    // Actions
    switch (def.cmd) {
      case '/new': selectConversation(null); break
      case '/export': exportConversation('md'); break
      case '/settings': pushSettingsHash('general'); break
      case '/skills': pushSettingsHash('skills'); break
      case '/plugins': pushSettingsHash('plugins'); break
      case '/connectors': pushSettingsHash('connectors'); break
      case '/projects': setProjectsOpen(true); break
      case '/model': (document.querySelector('button[title="Choose model"]') as HTMLElement | null)?.click(); break
      case '/undo': {
        // Non-destructive (Â§8-22): the last prompt goes back in the composer
        // as a pending branch edit — re-sending keeps the old turn as a
        // version instead of deleting it.
        const pathMsgs = messages as Message[]
        const lastUser = [...pathMsgs].reverse().find((m) => m.role === 'user')
        if (lastUser) editMessageAt(lastUser.id, lastUser.content)
        break
      }
      case '/retry': {
        const pathMsgs = messages as Message[]
        const lastUser = [...pathMsgs].reverse().find((m) => m.role === 'user')
        if (lastUser) retryBefore(pathMsgs.indexOf(lastUser))
        break
      }
      case '/stop': chat.stopRun(); break
      case '/help': setShortcutsOpen(true); break
      case '/bot': setInput(''); setPickerOpen(true); break
      default: setInput(def.cmd + ' ')
    }
  }

  // â”€â”€ Derived â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Hydration-safe account row: reading localStorage at render time
  // mismatches the prerendered export (React #418 uncaught), so the first
  // paint matches the export and the signed-in user lands via an effect.
  const [user, setUser] = useState<ReturnType<typeof getStoredUser>>(null)
  useEffect(() => { setUser(getStoredUser()) }, [])
  const theme = useTheme()
  /** Â§8-35: cycle light â†’ dark â†’ system from the header. */
  const cycleTheme = () => {
    const next = theme.choice === 'light' ? 'dark' : theme.choice === 'dark' ? 'system' : 'light'
    theme.setChoice(next)
    toast.push('info', `Theme: ${next === 'system' ? 'System' : next === 'light' ? 'Light' : 'Dark'}`)
  }
  const logout = () => {
    logoutSession()
    // Reload: the guest-check reopens the sign-in panel beside the chat.
    window.location.href = '/'
  }
  /** Artifact cards (chat + live run) open the right panel focused (audit P2). */
  const openArtifact = (a: import('../lib/stream').ArtifactRef) => {
    setFocusedArtifactId(a.id)
    panels.setArtifactsOpen(true)
  }
  /** Â§8-28: per-step "View in panel" links resolve artifact names to refs
   *  (live-run artifacts first, then the stored conversation's). */
  const openArtifactByName = (name: string) => {
    const found = allArtifacts.find((a) => a.name === name)
    if (found) openArtifact(found)
  }
  /** "Fix error" from the sandboxed preview: pre-fill the composer with the
   * error + artifact source so the agent regenerates a corrected artifact. */
  const handleFixError = (prompt: string) => {
    setInput(prompt)
    requestAnimationFrame(() => document.querySelector('textarea')?.focus())
  }
  /** Per-artifact "Building…" placeholders: artifact-producing tools that are
   * in flight in the live turn (create_document/generate_image/video/style). */
  const ARTIFACT_TOOLS = new Set(['create_document', 'generate_image', 'generate_video', 'generate_style'])
  const buildingKinds = showRunning
    ? [...new Set(chat.liveSteps.filter((s) => s.kind === 'tool' && s.tool && !s.tool.result && ARTIFACT_TOOLS.has(s.tool.name)).map((s) => s.tool!.name))]
    : []
  // Every artifact from the loaded conversation plus the live run.
  const allArtifacts = [
    ...(messages as Message[]).flatMap((m) => (m.metadata?.artifacts as import('../lib/stream').ArtifactRef[] | undefined) || []),
    ...(streamHere ? chat.liveArtifacts : []),
  ]
  const convTitle = (conversations as Conversation[]).find((c) => c.id === currentConversationId)?.title
  // Context meter (Â§2.5): honest estimate — chars/4 over the conversation,
  // against the standard 32k window (the large tier has more headroom).
  const contextTokens = Math.ceil(((messages as Message[]).reduce((n, m) => n + (m.content?.length || 0), 0) + chat.liveAnswer.length) / 4)
  const contextPct = Math.min(100, Math.round((contextTokens / 32_768) * 100))
  const chatConversations = (conversations as Conversation[]).filter((c) => !c.kind || c.kind === 'chat')
  const listedActive = (conversations as Conversation[]).find((c) => c.id === currentConversationId)
  const activeConv = listedActive?.kind && listedActive.kind !== 'chat'
    ? listedActive
    : threadMeta?.id === currentConversationId
      ? { ...listedActive, id: currentConversationId!, kind: threadMeta.kind, botId: threadMeta.botId, botIds: threadMeta.botIds } as Conversation
      : listedActive
  const profileBotId = activeConv?.kind === 'bot' ? (activeConv.botId || openedBotId) : openedBotId
  const profileBot = profileBotId ? roster.bots.find((b) => b.id === profileBotId) || null : null
  const authors = Object.fromEntries(roster.bots.map((b) => [b.id, { name: b.name, color: b.avatarColor }]))
  const liveAuthor = streamHere && streamingBotId ? authors[streamingBotId] || null : null
  const liveCanvas = streamHere ? canvasFromTurn(chat.liveSteps, chat.liveAnswer) : null
  const storedCanvas = (() => {
    const msgs = messages as Message[]
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role !== 'assistant') continue
      const steps = Array.isArray(m.metadata?.steps) ? m.metadata.steps : []
      const doc = canvasFromStored(steps, m.content || '')
      if (doc) return doc
    }
    return null
  })()
  const canvasDoc = canvasDismissed ? null : (liveCanvas || storedCanvas)
  const composerPlaceholder = profileBot
    ? `Message ${profileBot.name}`
    : activeConv?.kind === 'group'
      ? 'Message the group'
      : 'Message…'
  cycleConversationRef.current = (dir) => {
    if (!chatConversations.length) return
    const idx = chatConversations.findIndex((c) => c.id === currentConversationId)
    const next = chatConversations[(idx + dir + chatConversations.length) % chatConversations.length]
    if (next) selectConversation(next.id)
  }

  async function refreshRoster() {
    try { setRoster(await listNamedBots()) } catch { /* roster stays as last good list */ }
  }
  useEffect(() => {
    if (!user) return
    void refreshRoster()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, chat.running])

  async function openBot(bot: NamedBot) {
    setPickerOpen(false)
    try {
      const thread = bot.conversationId ? { id: bot.conversationId } : await openBotThread(bot.id)
      selectConversation(thread.id)
      setOpenedBotId(bot.id)
      setThreadMeta({ id: thread.id, kind: 'bot', botId: bot.id })
      panels.setSidebarOpen(false)
      invalidateConversations()
      void refreshRoster()
    } catch (err: any) {
      toast.push('error', err?.message || 'Could not open that bot')
    }
  }
  async function openGroup(group: BotGroup) {
    setPickerOpen(false)
    selectConversation(group.id)
    setThreadMeta({ id: group.id, kind: 'group', botIds: group.botIds })
    panels.setSidebarOpen(false)
  }

  // Sidebar contents — shared by the docked column (md+) and the mobile drawer.
  const sidebarContents = (
    <Sidebar
      conversations={chatConversations}
      currentConversationId={currentConversationId}
      user={user}
      projects={projects}
      activeProjectId={activeProjectId}
      onSelectConversation={(id) => { selectConversation(id); panels.closeOverlays() }}
      onClose={() => panels.setSidebarOpen(false)}
      onOpenSettings={() => pushSettingsHash('general')}
      onLogout={logout}
      onRenameConversation={async (id, title) => { try { await updateConv.mutateAsync({ id, title }) } catch { return false } }}
      onDeleteConversation={(id) => deleteConv.mutate(id)}
      onPinConversation={(id, pinned) => updateConv.mutate({ id, pinned })}
      onShareConversation={handleShareConversation}
      searchQuery={sidebarSearch}
      onSearchChange={setSidebarSearch}
      messageHits={messageHits}
      sessionsError={sessionsError}
      sessionsPending={sessionsPending}
      onRetrySessions={retrySessions}
      searchError={searchError}
      onRetrySearch={retrySearch}
      onOpenProjects={() => setProjectsOpen(true)}
      onSelectProject={(id) => { setActiveProjectId(id); if (id) localStorage.setItem('activeProjectId', id); else localStorage.removeItem('activeProjectId') }}
      activeProjectName={activeProjectId ? (projects.find((p) => p.id === activeProjectId)?.name || undefined) : undefined}
      bots={roster.bots}
      groups={roster.groups}
      activeBotId={profileBot?.id || null}
      activeGroupId={activeConv?.kind === 'group' ? activeConv.id : null}
      onOpenBot={(bot) => { void openBot(bot) }}
      onOpenGroup={(group) => { void openGroup(group) }}
      onCreateBot={() => { setPickerOpen(false); setCreateBotOpen(true) }}
      onCreateGroup={() => { setPickerOpen(false); setCreateGroupOpen(true) }}
      onStartChat={() => setPickerOpen(true)}
    />
  )

  return (
    <div className="flex h-[100dvh] overflow-hidden text-slate-200 bg-[#08080a]">
      {/* Mobile backdrop — only below the tablet breakpoint; from 768px up
          the sidebar is a persistent column and the artifacts panel is the
          only overlay. */}
      {(panels.sidebarOpen || panels.artifactsOpen) && !panels.isTablet && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-30"
          onClick={panels.closeOverlays}
        />
      )}

      {/* â”€â”€ Left sidebar — a docked column from 768px up, a drawer below.
          The docked case is a plain flex column toggled by WIDTH: a
          transform (the old approach) is paint-only, so the panel could sit
          off-screen while its 320px of flow stayed reserved — which is what
          pushed the whole transcript off-centre. â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {panels.isTablet ? (
        <aside
          aria-label="Sidebar"
          aria-hidden={!panels.sidebarOpen}
          style={{ width: panels.sidebarOpen ? sidebarWidth.width : 0 }}
          className={`shrink-0 h-full overflow-hidden bg-[#0a0a0c] border-r border-white/[0.06] ${sidebarResizing ? '' : 'transition-[width] duration-200 ease-out'} ${
            panels.sidebarOpen ? '' : 'border-r-0'
          }`}
        >
          <div className="h-full" style={{ width: sidebarWidth.width }}>{sidebarContents}</div>
        </aside>
      ) : (
        <AnimatePresence initial={false}>
          {panels.sidebarOpen && (
            <motion.aside
              aria-label="Sidebar"
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: 'spring', stiffness: 380, damping: 34 }}
              className="fixed inset-y-0 left-0 w-[min(20rem,calc(100vw-2rem))] shrink-0 flex flex-col h-full z-40 pt-[env(safe-area-inset-top)] bg-[#0a0a0c] border-r border-white/[0.06]"
            >
              {sidebarContents}
            </motion.aside>
          )}
        </AnimatePresence>
      )}

      {panels.isTablet && panels.sidebarOpen && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={SIDEBAR_WIDTH_MIN}
          aria-valuemax={SIDEBAR_WIDTH_MAX}
          aria-valuenow={sidebarWidth.width}
          tabIndex={0}
          title="Drag to resize"
          onPointerDown={(e) => {
            const handle = e.currentTarget
            handle.setPointerCapture(e.pointerId)
            const startX = e.clientX
            const startW = sidebarWidth.width
            const move = (ev: PointerEvent) => sidebarWidth.setWidth(startW + (ev.clientX - startX))
            setSidebarResizing(true)
            const up = () => {
              setSidebarResizing(false)
              handle.removeEventListener('pointermove', move)
              handle.removeEventListener('pointerup', up)
              handle.removeEventListener('pointercancel', up)
            }
            handle.addEventListener('pointermove', move)
            handle.addEventListener('pointerup', up)
            handle.addEventListener('pointercancel', up)
          }}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 24 : 8
            if (e.key === 'ArrowRight') { e.preventDefault(); sidebarWidth.setWidth(sidebarWidth.widthRef.current + step) }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); sidebarWidth.setWidth(sidebarWidth.widthRef.current - step) }
            else if (e.key === 'Home') { e.preventDefault(); sidebarWidth.setWidth(SIDEBAR_WIDTH_MIN) }
            else if (e.key === 'End') { e.preventDefault(); sidebarWidth.setWidth(SIDEBAR_WIDTH_MAX) }
          }}
          className="relative shrink-0 w-1.5 cursor-col-resize touch-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#c96442]"
        >
          <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/10" />
        </div>
      )}

      <AnimatePresence>
        {projectsOpen && (
          <ProjectsPanel
            workspaceId={workspaceId}
            activeProjectId={activeProjectId}
            bots={roster.bots.map((bot) => ({ id: bot.id, name: bot.name }))}
            onSelect={(id) => { setActiveProjectId(id); if (id) localStorage.setItem('activeProjectId', id); else localStorage.removeItem('activeProjectId') }}
            onClose={() => { setProjectsOpen(false); refreshProjects() }}
            onOpenRoom={(room) => {
              setProjectsOpen(false)
              selectConversation(room.id)
              setThreadMeta({ id: room.id, kind: 'group', botIds: room.botIds })
              invalidateConversations()
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {researchOpen && (
          <ResearchPanel conversationId={currentConversationId} onClose={() => setResearchOpen(false)} />
        )}
      </AnimatePresence>

      {/* â”€â”€ Center: conversation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <main className="flex-1 flex flex-col h-full min-w-0 relative pt-[env(safe-area-inset-top)]">
        <ChatHeader
          sidebarOpen={panels.sidebarOpen}
          convTitle={convTitle}
          modelTier={modelTier}
          onModelChange={(id) => { setModelTier(id); setModelTierState(id) }}
          incognito={incognito}
          onToggleIncognito={() => {
            const next = !incognito
            setIncognito(next)
            // Toggling applies to the next conversation — leave the current one.
            if (currentConversationId) { setCurrentConversationId(null); setPendingBranch(undefined); messageQueue.clear(); chat.clearTurn(); setInput('') }
          }}
          hasMessages={messages.length > 0}
          onExport={exportConversation}
          artifactCount={allArtifacts.length}
          artifactsOpen={panels.artifactsOpen}
          onToggleArtifacts={() => panels.setArtifactsOpen((v) => !v)}
          hasConversation={!!currentConversationId}
          researchOpen={researchOpen}
          onToggleResearch={() => setResearchOpen((v) => !v)}
          onOpenSidebar={() => panels.setSidebarOpen((open) => !open)}
          theme={theme.choice}
          onCycleTheme={cycleTheme}
          onOpenShortcuts={() => setShortcutsOpen(true)}
        />

        {/* (S8) transcript fetch failed — an explicit error state, not the
            old silent blank (which read exactly like a new chat). */}
        {messagesError && messages.length === 0 && (
          <div className="max-w-[48rem] mx-auto px-4 pt-4">
            <div className="rounded-xl border border-rose-400/25 bg-rose-500/[0.07] px-4 py-3 text-[13px] text-rose-200 flex items-center gap-3">
              <span className="flex-1">Couldn&apos;t load this conversation.</span>
              <button type="button" onClick={() => retryMessages()} className="shrink-0 text-[#e79d7f] hover:underline">Retry</button>
            </div>
          </div>
        )}

        {/* Messages */}
        <MessageList
          messages={messages}
          conversationId={currentConversationId}
          liveUser={streamHere ? chat.liveUser : null}
          liveSteps={streamHere ? chat.liveSteps : []}
          liveAnswer={streamHere ? chat.liveAnswer : ''}
          liveThinking={streamHere ? chat.liveThinking : ''}
          liveArtifacts={streamHere ? chat.liveArtifacts : []}
          /** Â§8-22: while a retry/edit run streams, the transcript truncates
           * at this row and the live turn renders in its place. */
          liveReplaceAfterId={streamHere ? chat.liveAnchorId : null}
          /** Â§8-22 version arrows: per-row sibling info + the switch handler. */
          versions={branchVersions}
          onSelectVersion={(messageId) => selectVersionRow(currentConversationId, messageId)}
          /** Â§8-39: messages queued behind the active run (pending bubbles). */
          queued={messageQueue.queue}
          onRemoveQueued={messageQueue.remove}
          onStartPrompt={(prompt) => { setInput(prompt); setTimeout(() => document.querySelector('textarea')?.focus(), 100) }}
          running={showRunning}
          statusMsg={streamHere ? chat.statusMsg : ''}
          errorMsg={chat.errorMsg}
          onClearError={chat.clearError}
          mode={mode}
          pendingApproval={streamHere ? chat.pendingApproval : null}
          onApprove={(approvalId) => { chat.pendingApproval?.approve(true, approvalId).then(() => chat.setPendingApproval(null)).catch(() => {}) }}
          onDeny={(approvalId) => { chat.pendingApproval?.approve(false, approvalId).then(() => chat.setPendingApproval(null)).catch(() => {}) }}
          toolCount={toolCount}
          onOpenTools={() => pushSettingsHash('tools') }
          onOpenArtifact={openArtifact}
          onOpenArtifactByName={openArtifactByName}
          onEditMessage={editMessageAt}
          onRetryBefore={retryBefore}
          editingMessageId={editingMessageId}
          authors={authors}
          liveAuthor={liveAuthor}
        />

        {/* Composer — bottom padding lifts above the iOS keyboard via the
            --kb-offset variable from useKeyboardSafeBottom (audit P6). */}
        <div className="border-t border-white/[0.05] px-3 sm:px-4 py-3 sm:py-4 pb-[max(0.75rem,calc(env(safe-area-inset-bottom)+var(--kb-offset)))] bg-[#08080a]">
          <div className="max-w-[48rem] mx-auto">
            {/* Â§8-22 pending-branch banner: an edited prompt is loaded and the
                next send starts a new version — visible + cancellable. */}
            {pendingBranch !== undefined && (
              <div data-testid="branch-edit-banner" className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-[#c96442]/30 bg-[#c96442]/[0.07] px-3 py-2 text-[12.5px] text-[#e79d7f]">
                <span>Editing a message — your next send starts a new version of this turn.</span>
                <button type="button" onClick={cancelEdit} className="shrink-0 rounded-md px-1.5 py-0.5 hover:bg-white/[0.06] transition" aria-label="Cancel edit">Cancel</button>
              </div>
            )}
            {/* Slash palette dismiss boundary: the textarea is the palette's
                trigger, so click-away/Escape is bound at the composer wrap. */}
            <div ref={slashBoundaryRef}>
            <Composer
              input={input}
              attachments={uploads.attachments}
              onRemoveAttachment={uploads.remove}
              onRetryAttachment={uploads.retry}
              running={showRunning}
              runMode={runMode}
              webSearch={webSearch}
              onToggleWebSearch={setWebSearch}
              thinking={thinking}
              onToggleThinking={setThinking}
              contextPct={contextPct}
              contextTokens={contextTokens}
              incognito={incognito}
              showSlash={showSlash}
              showPlus={showPlus}
              onInputChange={handleInputChange}
              onSelectSlashCommand={handleSlashCommand}
              onSend={handleSend}
              onStop={chat.stopRun}
              onImagesSelected={handleImagesSelected}
              onTogglePlus={() => setShowPlus((v) => !v)}
              onClosePlus={() => setShowPlus(false)}
              onRunModeChange={setRunMode}
              onOpenConnectors={() => { setShowPlus(false); pushSettingsHash('connectors') }}
              onOpenSettingsTab={(tab) => { setShowPlus(false); pushSettingsHash(tab) }}
              connections={workspaceConnections.connections}
              pinnedConnectionId={workspaceConnections.pinnedId}
              onTogglePinConnection={workspaceConnections.togglePin}
              voiceMode={voiceMode.active}
              voiceModeSupported={voiceMode.supported}
              voiceModeListening={voiceMode.listening}
              onToggleVoiceMode={voiceMode.toggle}
              queuedCount={messageQueue.queue.length}
              placeholder={composerPlaceholder}
              onPromptHistory={walkPromptHistory}
              onCycleConversation={(dir) => cycleConversationRef.current(dir)}
              onCancelEdit={pendingBranch !== undefined ? cancelEdit : undefined}
              onEditUndo={undoEdit}
              onEditRedo={redoEditAction}
              onCloseSlash={() => setShowSlash(false)}
              mentionMembers={activeConv?.kind === 'group'
                ? roster.bots
                  .filter((bot) => (Array.isArray(activeConv.botIds) ? activeConv.botIds : []).includes(bot.id))
                  .map((bot) => ({ id: bot.id, name: bot.name }))
                : undefined}
            />
            </div>
          </div>
        </div>
      </main>

      {/* â”€â”€ Right: Artifacts panel (viewable output only — agent activity is
          inline per turn, audit P1/P2). â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {canvasDoc && (
        <CanvasPanel doc={canvasDoc} onClose={() => setCanvasDismissed(true)} />
      )}
      {!canvasDoc && profileBot && (
        <BotProfilePanel
          bot={profileBot}
          onLabel={(label) => { void updateNamedBot(profileBot.id, { label }).then(() => refreshRoster()).catch(() => {}) }}
        />
      )}
      <AnimatePresence initial={false}>
        {panels.artifactsOpen && !canvasDoc && (
          <ArtifactsPanel
            artifacts={allArtifacts}
            focusId={focusedArtifactId}
            onBackToList={() => setFocusedArtifactId(null)}
            onFocusArtifact={(id) => setFocusedArtifactId(id)}
            buildingKinds={buildingKinds}
            onFixError={handleFixError}
            onClose={() => { panels.setArtifactsOpen(false); setFocusedArtifactId(null) }}
          />
        )}
      </AnimatePresence>

      {showSettings && (
        <SettingsPanel
          initialTab={settingsTab}
          workspaceId={workspaceId}
          onClose={() => { setShowSettings(false); setSettingsTab(undefined) }}
        />
      )}

      <AnimatePresence>
        {authPanelOpen && (
          <AuthSidePanel key="auth-panel" onClose={() => setAuthPanelOpen(false)} />
        )}
      </AnimatePresence>

      <CommandPalette
        onNewSession={() => { setCurrentConversationId(null); panels.setSidebarOpen(false) }}
        onSearchChats={() => openSidebarSearch(panels.setSidebarOpen)}
        onToggleSidebar={() => panels.setSidebarOpen((s) => !s)}
        onOpenSettings={() => pushSettingsHash('general') }
        onLogout={() => { logout(); panels.setSidebarOpen(false) }}
      />
      <ShortcutSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      {pickerOpen && (
        <StartChatPicker
          bots={roster.bots}
          onClose={() => setPickerOpen(false)}
          onCreateBot={() => { setPickerOpen(false); setCreateBotOpen(true) }}
          onCreateGroup={() => { setPickerOpen(false); setCreateGroupOpen(true) }}
          onPickBot={(bot) => { void openBot(bot) }}
        />
      )}
      {createBotOpen && (
        <CreateBotDialog
          busy={botBusy}
          onClose={() => setCreateBotOpen(false)}
          onCreate={async (input) => {
            setBotBusy(true)
            try {
              const created = await createNamedBot(input)
              setCreateBotOpen(false)
              selectConversation(created.conversationId)
              setOpenedBotId(created.bot.id)
              setThreadMeta({ id: created.conversationId, kind: 'bot', botId: created.bot.id })
              await refreshRoster()
            } catch (err: any) {
              toast.push('error', err?.message || 'Could not create that bot')
            } finally { setBotBusy(false) }
          }}
        />
      )}
      {createGroupOpen && (
        <CreateGroupDialog
          bots={roster.bots}
          busy={botBusy}
          onClose={() => setCreateGroupOpen(false)}
          onCreate={async (botIds, name) => {
            setBotBusy(true)
            try {
              const created = await createBotGroup(botIds, name || undefined)
              setCreateGroupOpen(false)
              selectConversation(created.id)
              setThreadMeta({ id: created.id, kind: 'group', botIds: created.botIds })
              await refreshRoster()
            } catch (err: any) {
              toast.push('error', err?.message || 'Could not create that group')
            } finally { setBotBusy(false) }
          }}
        />
      )}
    </div>
  )
}
