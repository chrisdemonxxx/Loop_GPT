'use client'

import { useState, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import axios from 'axios'

import { API_URL, authHeaders, getStoredUser, getToken, getModelTier, setModelTier, type AgentMode } from '../lib/api'
import { getDraft, setDraft, deleteDraft } from '../lib/drafts'
import SettingsPanel from '../components/SettingsPanel'
import { CommandPalette } from '../components/CommandPalette'
import { ShortcutSheet } from '../components/ShortcutSheet'

import Sidebar from '../components/chat/Sidebar'
import Composer from '../components/chat/Composer'
import MessageList from '../components/chat/MessageList'
import ArtifactsPanel from '../components/chat/ArtifactsPanel'
import ChatHeader from '../components/chat/ChatHeader'
import type { Conversation, Message } from '../components/chat/types'
import { parseCommand, SLASH_COMMANDS } from '../lib/commands'
import ProjectsPanel, { type Project } from '../components/ProjectsPanel'
import ResearchPanel from '../components/ResearchPanel'
import { usePanels, useWorkspaceProjects, useConversationsData, useChatStream } from './hooks'

// slash commands live in ../lib/commands (registry + parseCommand)

/** The chat workspace: sidebar, header, transcript, composer, and the
 * activity/artifacts overlays. All run mechanics live in ./hooks; presenters
 * live in ../components/chat. */
export default function ChatPage() {
  // ── Panels (sidebar / activity / artifacts + desktop detection) ───────────
  const panels = usePanels()

  // ── Session / UI state ────────────────────────────────────────────────────
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<AgentMode>('agent')
  const [showSlash, setShowSlash] = useState(false)
  const [showPlus, setShowPlus] = useState(false)
  const [showModeMenu, setShowModeMenu] = useState(false)
  const [runMode, setRunMode] = useState<'auto' | 'plan' | 'accept' | 'step'>('auto')
  const [incognito, setIncognito] = useState(false)
  const [modelTier, setModelTierState] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [researchOpen, setResearchOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [toolCount, setToolCount] = useState(0)
  /** Artifact panel focus (P2): set by artifact-card clicks; the panel opens
   * focused and "Back to list" clears it while staying open. */
  const [focusedArtifactId, setFocusedArtifactId] = useState<string | null>(null)

  // ── Attachments (null = all tools, the server default) ─────────────────────
  const [selectedImages, setSelectedImages] = useState<File[]>([])
  const [imagePreviews, setImagePreviews] = useState<string[]>([])
  const [selectedDocs, setSelectedDocs] = useState<File[]>([])
  const [selectedTools, setSelectedTools] = useState<Set<string> | null>(null)

  // ── Data ──────────────────────────────────────────────────────────────────
  const { workspaceId, projects, activeProjectId, setActiveProjectId, refreshProjects } = useWorkspaceProjects()
  const { conversations, messages, updateConv, deleteConv, invalidateConversations, invalidateMessages } =
    useConversationsData(currentConversationId, (id) => { if (currentConversationId === id) setCurrentConversationId(null) })
  const chat = useChatStream()

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

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (getStoredUser() || getToken()) return
    fetch(`${API_URL}/api/auth/providers`)
      .then((r) => r.json())
      .then((d) => { if (!d.guest) window.location.href = '/login' })
      .catch(() => {})
  }, [])

  // ── Conversation helpers ──────────────────────────────────────────────────
  function selectConversation(id: string | null) {
    // Drafts (§2.5): stash the in-progress text for the outgoing chat, then
    // restore whatever was in progress for the incoming one.
    if (typeof window !== 'undefined') {
      const prevKey = `draft:${currentConversationId || 'new'}`
      const nextKey = `draft:${id || 'new'}`
      if (input.trim()) setDraft(prevKey, input)
      else deleteDraft(prevKey)
      getDraft(nextKey).then((saved) => { if (saved && typeof saved === 'string') setInput(saved) })
    }
    setCurrentConversationId(id)
    chat.resetLive()
    panels.setArtifactsOpen(false)
  }

  async function ensureConversation(firstMessage: string): Promise<string> {
    if (currentConversationId) return currentConversationId
    const res = await axios.post(
      `${API_URL}/api/conversations`,
      { title: firstMessage.slice(0, 50) || 'New Chat' },
      { headers: authHeaders() }
    )
    setCurrentConversationId(res.data.id)
    invalidateConversations()
    return res.data.id
  }

  /** Message branching (§2.5): editing an earlier user message forks the
   * conversation at that point into a new branch and loads the text. */
  async function forkAtMessage(messageId: string, content: string) {
    if (!currentConversationId) { setInput(content); return }
    try {
      const res = await fetch(`${API_URL}/api/conversations/${currentConversationId}/fork`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ messageId }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.conversationId) { setInput(content); return }
      setCurrentConversationId(d.conversationId)
      chat.resetLive()
      panels.setArtifactsOpen(false)
      invalidateConversations()
      setInput(content)
      requestAnimationFrame(() => document.querySelector('textarea')?.focus())
    } catch { setInput(content) }
  }

  /** Rewind to the user prompt that precedes the given assistant message:
   * truncate after that prompt, put it back in the composer, and scroll up —
   * so re-sending replaces the branch instead of appending. */
  async function retryBefore(index: number) {
    let userIdx = index - 1
    while (userIdx >= 0 && messages[userIdx]?.role !== 'user') userIdx--
    const userMsg = messages[userIdx]
    if (!userMsg) return
    setInput(userMsg.content)
    if (currentConversationId && userMsg.id) {
      try {
        await axios.post(`${API_URL}/api/conversations/${currentConversationId}/rewind`,
          { messageId: userMsg.id }, { headers: authHeaders() })
        await invalidateMessages(currentConversationId)
        await invalidateConversations()
      } catch { /* offline: the prompt is still in the composer */ }
    }
    requestAnimationFrame(() => {
      document.querySelector('textarea')?.focus()
    })
  }

  // ── Composer / send ────────────────────────────────────────────────────────
  /** Add up to four attachments at once. Images preview locally; documents
   * (PDF/DOCX/XLSX/CSV/TXT/MD) show as chips and are extracted server-side. */
  function handleImagesSelected(files: File[]) {
    const images = files.filter((f) => f.type.startsWith('image/'))
    const docs = files.filter((f) => !f.type.startsWith('image/') && /\.(pdf|docx|xlsx|csv|txt|md|markdown)$/i.test(f.name))
    const slots = Math.max(0, 4 - selectedImages.length - selectedDocs.length)
    if (images.length) {
      setSelectedImages((prev) => [...prev, ...images].slice(0, 4))
      for (const file of images.slice(0, slots)) {
        const r = new FileReader()
        r.onloadend = () => setImagePreviews((prev) => (prev.length >= 4 ? prev : [...prev, r.result as string]))
        r.readAsDataURL(file)
      }
    }
    if (docs.length) {
      setSelectedDocs((prev) => [...prev, ...docs.slice(0, Math.max(0, 4 - prev.length))].slice(0, 4))
    }
  }

  function removeDoc(index: number) {
    setSelectedDocs((prev) => prev.filter((_, i) => i !== index))
  }

  function handleInputChange(value: string) {
    setInput(value)
    setShowSlash(value.startsWith('/') && !/\s/.test(value))
  }

  async function handleSend(e?: React.FormEvent) {
    e?.preventDefault()
    if ((!input.trim() && !selectedImages.length && !selectedDocs.length) || chat.running) return
    const { mode: sendMode, text: content, tools: commandTools } = parseCommand(input.trim())
    if (!content && !selectedImages.length && !selectedDocs.length) return

    setMode(sendMode)
    setShowSlash(false); setShowPlus(false); setShowModeMenu(false)
    // Surface deep-research runs in the side panel so the user can watch
    // progress and read the cited report instead of it living only in chat.
    if (sendMode === 'research') setResearchOpen(true)
    const images = selectedImages
    const docs = selectedDocs
    const previews = imagePreviews
    setInput(''); setSelectedImages([]); setImagePreviews([]); setSelectedDocs([])
    if (typeof window !== 'undefined') deleteDraft(`draft:${currentConversationId || 'new'}`)

    await chat.send({
      content, sendMode, commandTools,
      images, docs, previews,
      runMode, modelTier,
      selectedTools, incognito,
      projectId: activeProjectId || undefined,
      ensureConversation,
    })
  }

  // ── Export / slash dispatch ─────────────────────────────────────────────────
  function exportConversation(format: 'md' | 'pdf' = 'md') {
    const title = (conversations as Conversation[]).find((c) => c.id === currentConversationId)?.title || 'conversation'
    const md = (messages as Message[]).map((m) => `**${m.role === 'user' ? 'You' : 'Loop GPT'}**\n\n${m.content}`).join('\n\n---\n\n')
    if (format === 'pdf') {
      // Print-to-PDF: a clean transcript stylesheet + the browser print dialog.
      const w = window.open('', '_blank', 'width=800,height=900')
      if (!w) return
      w.document.write(`<!doctype html><html><head><title>${title}</title><style>
        body{font:13px/1.65 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1e;max-width:720px;margin:32px auto;padding:0 24px}
        h1{font-size:22px;margin-bottom:4px} .meta{color:#888;font-size:12px;margin-bottom:28px}
        .msg{margin:18px 0;padding:14px;border-left:3px solid #c96442;background:#faf9f8;border-radius:6px;white-space:pre-wrap;word-break:break-word}
        .user{border-left-color:#1a1a1e;background:#f4f4f5} .who{font-weight:600;font-size:12px;color:#777;margin-bottom:6px}
      </style></head><body><h1>${title}</h1><div class="meta">Loop GPT transcript · ${new Date().toLocaleString()}</div>
      ${messages.map((m) => `<div class="msg ${m.role === 'user' ? 'user' : ''}"><div class="who">${m.role === 'user' ? 'You' : 'Loop GPT'}</div>${m.content.replace(/</g, '&lt;')}</div>`).join('')}
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
      case '/settings': setSettingsTab(undefined); setShowSettings(true); break
      case '/skills': setSettingsTab('skills'); setShowSettings(true); break
      case '/plugins': setSettingsTab('plugins'); setShowSettings(true); break
      case '/connectors': setSettingsTab('connectors'); setShowSettings(true); break
      case '/projects': setProjectsOpen(true); break
      case '/model': (document.querySelector('button[title="Choose model"]') as HTMLElement | null)?.click(); break
      case '/undo': retryBefore((messages as Message[]).length - 1); break
      case '/retry': {
        const last = [...(messages as Message[])].reverse().find((m) => m.role === 'user')
        if (last) { retryBefore((messages as Message[]).indexOf(last)) }
        break
      }
      case '/stop': chat.stopRun(); break
      case '/help': window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' })); break
      default: setInput(def.cmd + ' ')
    }
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const user = getStoredUser()
  const logout = () => {
    localStorage.removeItem('token'); localStorage.removeItem('user')
    window.location.href = '/login'
  }
  /** Artifact cards (chat + live run) open the right panel focused (audit P2). */
  const openArtifact = (a: import('../lib/stream').ArtifactRef) => {
    setFocusedArtifactId(a.id)
    panels.setArtifactsOpen(true)
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
  const buildingKinds = chat.running
    ? [...new Set(chat.liveSteps.filter((s) => s.kind === 'tool' && s.tool && !s.tool.result && ARTIFACT_TOOLS.has(s.tool.name)).map((s) => s.tool!.name))]
    : []
  // Every artifact from the loaded conversation plus the live run.
  const allArtifacts = [
    ...(messages as Message[]).flatMap((m) => (m.metadata?.artifacts as import('../lib/stream').ArtifactRef[] | undefined) || []),
    ...chat.liveArtifacts,
  ]
  const convTitle = (conversations as Conversation[]).find((c) => c.id === currentConversationId)?.title
  // Context meter (§2.5): honest estimate — chars/4 over the conversation,
  // against the standard 32k window (the large tier has more headroom).
  const contextTokens = Math.ceil(((messages as Message[]).reduce((n, m) => n + (m.content?.length || 0), 0) + chat.liveAnswer.length) / 4)
  const contextPct = Math.min(100, Math.round((contextTokens / 32_768) * 100))

  return (
    <div className="flex h-[100dvh] overflow-hidden text-slate-200 bg-[#111113]">
      {/* Mobile backdrop */}
      {panels.sidebarOpen && !panels.isDesktop && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-30 lg:hidden"
          onClick={panels.closeOverlays}
        />
      )}

      {/* ── Left sidebar ─────────────────────────────────────────────────── */}
      <AnimatePresence initial={false}>
        {panels.sidebarOpen && (
          <motion.aside
            initial={{ x: -280 }}
            animate={{ x: 0 }}
            exit={{ x: -280 }}
            transition={{ type: 'spring', stiffness: 380, damping: 34 }}
            className="fixed lg:relative inset-y-0 left-0 w-[260px] max-w-[82vw] shrink-0 flex flex-col h-full z-40 lg:z-20 pt-[env(safe-area-inset-top)] lg:pt-0 bg-[#0f0f11] border-r border-white/[0.05]"
          >
            <Sidebar
              conversations={conversations}
              currentConversationId={currentConversationId}
              user={user}
              projects={projects}
              activeProjectId={activeProjectId}
              onSelectConversation={(id) => { selectConversation(id); panels.closeOverlays() }}
              onClose={() => panels.setSidebarOpen(false)}
              onOpenSettings={() => setShowSettings(true)}
              onLogout={logout}
              onRenameConversation={(id, title) => updateConv.mutate({ id, title })}
              onDeleteConversation={(id) => deleteConv.mutate(id)}
              onOpenProjects={() => setProjectsOpen(true)}
              onSelectProject={(id) => { setActiveProjectId(id); if (id) localStorage.setItem('activeProjectId', id); else localStorage.removeItem('activeProjectId') }}
              activeProjectName={activeProjectId ? (projects.find((p) => p.id === activeProjectId)?.name || undefined) : undefined}
            />
          </motion.aside>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {projectsOpen && (
          <ProjectsPanel
            workspaceId={workspaceId}
            activeProjectId={activeProjectId}
            onSelect={(id) => { setActiveProjectId(id); if (id) localStorage.setItem('activeProjectId', id); else localStorage.removeItem('activeProjectId') }}
            onClose={() => { setProjectsOpen(false); refreshProjects() }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {researchOpen && (
          <ResearchPanel conversationId={currentConversationId} onClose={() => setResearchOpen(false)} />
        )}
      </AnimatePresence>

      {/* ── Center: conversation ─────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col h-full min-w-0 relative pt-[env(safe-area-inset-top)]">
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
            if (currentConversationId) { setCurrentConversationId(null); chat.clearTurn(); setInput('') }
          }}
          hasMessages={messages.length > 0}
          onExport={exportConversation}
          artifactCount={allArtifacts.length}
          artifactsOpen={panels.artifactsOpen}
          onToggleArtifacts={() => panels.setArtifactsOpen((v) => !v)}
          hasConversation={!!currentConversationId}
          researchOpen={researchOpen}
          onToggleResearch={() => setResearchOpen((v) => !v)}
          onOpenSidebar={() => panels.setSidebarOpen(true)}
        />

        {/* Messages */}
        <MessageList
          messages={messages}
          liveUser={chat.liveUser}
          liveSteps={chat.liveSteps}
          liveAnswer={chat.liveAnswer}
          liveThinking={chat.liveThinking}
          liveArtifacts={chat.liveArtifacts}
          onStartPrompt={(prompt) => { setInput(prompt); setTimeout(() => document.querySelector('textarea')?.focus(), 100) }}
          running={chat.running}
          statusMsg={chat.statusMsg}
          mode={mode}
          pendingApproval={chat.pendingApproval}
          onApprove={() => { chat.pendingApproval?.approve(true).then(() => chat.setPendingApproval(null)) }}
          onDeny={() => { chat.pendingApproval?.approve(false).then(() => chat.setPendingApproval(null)) }}
          toolCount={toolCount}
          onOpenTools={() => { setSettingsTab('tools'); setShowSettings(true) }}
          onOpenArtifact={openArtifact}
          onEditMessage={forkAtMessage}
          onRetryBefore={retryBefore}
        />

        {/* Composer */}
        <div className="border-t border-white/[0.05] px-3 sm:px-4 py-3 sm:py-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-[#111113]">
          <div className="max-w-[48rem] mx-auto">
            <Composer
              input={input}
              imagePreviews={imagePreviews}
              docNames={selectedDocs.map((d) => d.name)}
              running={chat.running}
              runMode={runMode}
              contextPct={contextPct}
              contextTokens={contextTokens}
              incognito={incognito}
              showSlash={showSlash}
              showPlus={showPlus}
              showModeMenu={showModeMenu}
              onInputChange={handleInputChange}
              onSelectSlashCommand={handleSlashCommand}
              onSend={handleSend}
              onStop={chat.stopRun}
              onImagesSelected={handleImagesSelected}
              onRemoveImage={(i) => {
                setSelectedImages((prev) => prev.filter((_, idx) => idx !== i))
                setImagePreviews((prev) => prev.filter((_, idx) => idx !== i))
              }}
              onRemoveDoc={removeDoc}
              onTogglePlus={() => setShowPlus((v) => !v)}
              onClosePlus={() => setShowPlus(false)}
              onToggleModeMenu={() => setShowModeMenu((v) => !v)}
              onCloseModeMenu={() => setShowModeMenu(false)}
              onRunModeChange={setRunMode}
              onOpenConnectors={() => { setShowPlus(false); setSettingsTab('connectors'); setShowSettings(true) }}
              onOpenSettingsTab={(tab) => { setShowPlus(false); setSettingsTab(tab); setShowSettings(true) }}
              toolSelectionCount={selectedTools ? selectedTools.size : null}
            />
          </div>
        </div>
      </div>

      {/* ── Right: Artifacts panel (viewable output only — agent activity is
          inline per turn, audit P1/P2). ─────────────────────────────────── */}
      <AnimatePresence initial={false}>
        {panels.artifactsOpen && (
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

      <CommandPalette
        onNewSession={() => { setCurrentConversationId(null); panels.setSidebarOpen(false) }}
        onToggleSidebar={() => panels.setSidebarOpen((s) => !s)}
        onOpenSettings={() => { setSettingsTab(undefined); setShowSettings(true) }}
        onLogout={() => { logout(); panels.setSidebarOpen(false) }}
      />
      <ShortcutSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <button
        type="button"
        aria-label="Keyboard shortcuts"
        onClick={() => setShortcutsOpen(true)}
        className="fixed bottom-4 right-4 z-30 p-2 rounded-lg text-slate-600 hover:text-slate-400 hover:bg-white/[0.04] transition text-[12px] font-mono"
        title="Keyboard shortcuts (?)"
      >
        ⌘K ?
      </button>
    </div>
  )
}
