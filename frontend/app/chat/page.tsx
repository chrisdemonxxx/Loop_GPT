'use client'

import { useState, useRef, useEffect } from 'react'
import { PanelLeft, FileDown, Cpu, Sparkles, FlaskConical } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'

import { API_URL, authHeaders, getStoredUser, getToken, getModelTier, setModelTier, type AgentMode } from '../lib/api'
import { runAgentStream, type ArtifactRef } from '../lib/stream'
import SettingsPanel from '../components/SettingsPanel'
import { track } from '../components/Analytics'
import type { LiveStep } from '../components/AgentComputer'
import { CommandPalette } from '../components/CommandPalette'
import { ShortcutSheet } from '../components/ShortcutSheet'
import ModelSelector from '../components/ModelSelector'

import Sidebar from '../components/chat/Sidebar'
import Composer from '../components/chat/Composer'
import MessageList from '../components/chat/MessageList'
import ActivityPanel from '../components/chat/ActivityPanel'
import ArtifactsPanel from '../components/chat/ArtifactsPanel'
import { parseCommand, SLASH_COMMANDS } from '../lib/commands'
import ProjectsPanel, { type Project } from '../components/ProjectsPanel'
import ResearchPanel from '../components/ResearchPanel'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  messageType?: string
  imageUrl?: string
  attachmentId?: string
  toolUsed?: string
  metadata?: any
}
interface Conversation { id: string; title: string; createdAt: string; updatedAt: string }

// slash commands live in ../lib/commands (registry + parseCommand)

export default function ChatPage() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [computerOpen, setComputerOpen] = useState(false)
  const [artifactsOpen, setArtifactsOpen] = useState(false)
  const [isDesktop, setIsDesktop] = useState(false)

  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<AgentMode>('agent')
  const [showSlash, setShowSlash] = useState(false)
  const [showPlus, setShowPlus] = useState(false)
  const [showModeMenu, setShowModeMenu] = useState(false)
  const [runMode, setRunMode] = useState<'auto' | 'plan' | 'accept' | 'step'>('auto')
  const [modelTier, setModelTierState] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)

  const [selectedImages, setSelectedImages] = useState<File[]>([])
  const [imagePreviews, setImagePreviews] = useState<string[]>([])
  // null = all tools (server default); a set = an explicit per-chat selection.
  const [selectedTools, setSelectedTools] = useState<Set<string> | null>(null)
  // Projects
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [researchOpen, setResearchOpen] = useState(false)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)

  const [running, setRunning] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [liveUser, setLiveUser] = useState<{ content: string; image?: string; images?: string[] } | null>(null)
  const [liveSteps, setLiveSteps] = useState<LiveStep[]>([])
  const [pendingApproval, setPendingApproval] = useState<{ toolName: string; approve: (ok: boolean) => Promise<any> } | null>(null)
  const [liveArtifacts, setLiveArtifacts] = useState<ArtifactRef[]>([])
  const [toolCount, setToolCount] = useState(0)

  const autoOpenedRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const queryClient = useQueryClient()

  // ── Data ──────────────────────────────────────────────────────────────────
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
      if (currentConversationId === id) setCurrentConversationId(null)
    },
  })

  // ── Effects ───────────────────────────────────────────────────────────────
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

  async function refreshProjects() {
    if (!workspaceId) return
    try {
      const pr = await axios.get(`${API_URL}/api/workspaces/${workspaceId}/projects`, { headers: authHeaders() })
      setProjects(Array.isArray(pr.data) ? pr.data : [])
    } catch { /* ignore */ }
  }

  // Load the personal workspace + its projects once authenticated.
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

  useEffect(() => {
    const hasActivity = liveSteps.some((s) => s.kind === 'tool') || liveArtifacts.length > 0
    if (hasActivity && !autoOpenedRef.current) { autoOpenedRef.current = true; setComputerOpen(true) }
  }, [liveSteps, liveArtifacts])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(min-width: 1024px)')
    const apply = () => { setIsDesktop(mq.matches); setSidebarOpen(mq.matches) }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (getStoredUser() || getToken()) return
    fetch(`${API_URL}/api/auth/providers`)
      .then((r) => r.json())
      .then((d) => { if (!d.guest) window.location.href = '/login' })
      .catch(() => {})
  }, [])

  // ── Helpers ───────────────────────────────────────────────────────────────
  const openComputer = () => { setComputerOpen(true); setArtifactsOpen(false); if (!isDesktop) setSidebarOpen(false) }
  const closeOverlays = () => { if (!isDesktop) { setSidebarOpen(false); setComputerOpen(false); setArtifactsOpen(false) } }

  function selectConversation(id: string | null) {
    setCurrentConversationId(id)
    setLiveUser(null); setLiveSteps([]); setLiveArtifacts([]); setStatusMsg('')
    setArtifactsOpen(false)
  }

  // Every artifact from the loaded conversation plus the live run.
  const allArtifacts = [
    ...messages.flatMap((m) => (m.metadata?.artifacts as ArtifactRef[] | undefined) || []),
    ...liveArtifacts,
  ]

  function stopRun() { abortRef.current?.abort(); setRunning(false) }

  const user = getStoredUser()
  const logout = () => {
    localStorage.removeItem('token'); localStorage.removeItem('user')
    window.location.href = '/login'
  }

  async function ensureConversation(firstMessage: string): Promise<string> {
    if (currentConversationId) return currentConversationId
    const res = await axios.post(
      `${API_URL}/api/conversations`,
      { title: firstMessage.slice(0, 50) || 'New Chat' },
      { headers: authHeaders() }
    )
    setCurrentConversationId(res.data.id)
    queryClient.invalidateQueries({ queryKey: ['conversations'] })
    return res.data.id
  }

  async function uploadImage(convId: string, file: File): Promise<string | undefined> {
    const fd = new FormData()
    fd.append('image', file)
    try {
      return (await axios.post(`${API_URL}/api/conversations/${convId}/upload-image`, fd, { headers: authHeaders(false) })).data.attachmentId
    } catch { return undefined }
  }

  async function handleSend(e?: React.FormEvent) {
    e?.preventDefault()
    if ((!input.trim() && !selectedImages.length) || running) return
    const { mode: sendMode, text: content, tools: commandTools } = parseCommand(input.trim())
    if (!content && !selectedImages.length) return

    setMode(sendMode)
    setShowSlash(false); setShowPlus(false); setShowModeMenu(false)
    const images = selectedImages
    const previews = imagePreviews
    setInput(''); setSelectedImages([]); setImagePreviews([])
    setRunning(true); setStatusMsg(''); setLiveSteps([]); setLiveArtifacts([])
    autoOpenedRef.current = false
    setLiveUser({ content, image: previews[0], images: previews })
    track('message_sent', { mode: sendMode })

    let convId: string | null = null
    try {
      convId = await ensureConversation(content)
      const attachmentIds = (await Promise.all(images.map((f) => uploadImage(convId!, f)))).filter(Boolean) as string[]
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
        projectId: activeProjectId || undefined,
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
            prev.map((s) => (s.index === step && s.tool ? { ...s, tool: { ...s.tool, result: resultContent, isError } } : s))
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

  /** Add up to four images at once; previews are read locally. */
  function handleImagesSelected(files: File[]) {
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (!images.length) return
    setSelectedImages((prev) => {
      const next = [...prev, ...images].slice(0, 4)
      return next
    })
    for (const file of images.slice(0, Math.max(0, 4 - selectedImages.length))) {
      const r = new FileReader()
      r.onloadend = () => setImagePreviews((prev) => (prev.length >= 4 ? prev : [...prev, r.result as string]))
      r.readAsDataURL(file)
    }
  }

  function handleInputChange(value: string) {
    setInput(value)
    setShowSlash(value.startsWith('/') && !/\s/.test(value))
  }

  function exportConversation(format: 'md' | 'pdf' = 'md') {
    const title = conversations.find((c) => c.id === currentConversationId)?.title || 'conversation'
    const md = messages.map((m) => `**${m.role === 'user' ? 'You' : 'Loop GPT'}**\n\n${m.content}`).join('\n\n---\n\n')
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

  /**
   * Rewind to the user prompt that precedes the given assistant message:
   * truncate the conversation after that prompt, put it back in the composer,
   * and scroll up — so re-sending replaces the branch instead of appending.
   */
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
        await queryClient.invalidateQueries({ queryKey: ['messages', currentConversationId] })
        await queryClient.invalidateQueries({ queryKey: ['conversations'] })
      } catch { /* offline: the prompt is still in the composer */ }
    }
    requestAnimationFrame(() => {
      document.querySelector('textarea')?.focus()
    })
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
      case '/undo': retryBefore(messages.length - 1); break
      case '/retry': {
        const last = [...messages].reverse().find((m) => m.role === 'user')
        if (last) { retryBefore(messages.indexOf(last)) }
        break
      }
      case '/stop': stopRun(); break
      case '/help': window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' })); break
      default: setInput(def.cmd + ' ')
    }
  }

  const liveAnswer = liveSteps.filter((s) => s.kind === 'text').map((s) => s.text).join('')
  const convTitle = conversations.find((c) => c.id === currentConversationId)?.title

  return (
    <div className="flex h-[100dvh] overflow-hidden text-slate-200 bg-[#111113]">
      {/* Mobile backdrop */}
      {(sidebarOpen || computerOpen || artifactsOpen) && !isDesktop && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-30 lg:hidden"
          onClick={closeOverlays}
        />
      )}

      {/* ── Left sidebar ─────────────────────────────────────────────────── */}
      <AnimatePresence initial={false}>
        {sidebarOpen && (
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
              onSelectConversation={(id) => { selectConversation(id); closeOverlays() }}
              onClose={() => setSidebarOpen(false)}
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
        {/* Header */}
        <div className="flex items-center gap-2 px-3 sm:px-4 h-12 border-b border-white/[0.05] shrink-0 bg-[#111113]">
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-1.5 rounded-lg hover:bg-white/[0.05] text-slate-500 hover:text-slate-300 transition"
            >
              <PanelLeft size={17} />
            </button>
          )}
          {!sidebarOpen && (
            <div className="w-6 h-6 rounded-md bg-[#c96442] flex items-center justify-center shrink-0">
              <Sparkles size={13} className="text-white" />
            </div>
          )}
          <span className="text-[13px] font-medium text-slate-400 truncate">
            {convTitle || 'New session'}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <ModelSelector value={modelTier} onChange={(id) => { setModelTier(id); setModelTierState(id) }} />
            {messages.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setExportMenuOpen((v) => !v)}
                  title="Export conversation"
                  aria-label="Export conversation"
                  aria-haspopup="menu"
                  aria-expanded={exportMenuOpen}
                  className="p-1.5 rounded-lg hover:bg-white/[0.05] text-slate-500 hover:text-slate-300 transition"
                >
                  <FileDown size={15} />
                </button>
                {exportMenuOpen && (
                  <div role="menu" className="absolute right-0 top-full mt-1.5 w-40 glass rounded-xl border border-white/[0.08] overflow-hidden z-30 shadow-panel">
                    <button role="menuitem" onClick={() => { setExportMenuOpen(false); exportConversation('md') }} className="w-full text-left px-3 py-2 text-[13px] text-slate-200 hover:bg-white/[0.05] transition">Markdown (.md)</button>
                    <button role="menuitem" onClick={() => { setExportMenuOpen(false); exportConversation('pdf') }} className="w-full text-left px-3 py-2 text-[13px] text-slate-200 hover:bg-white/[0.05] transition">PDF (print)</button>
                  </div>
                )}
              </div>
            )}
            {allArtifacts.length > 0 && (
              <button
                onClick={() => { setArtifactsOpen((v) => !v); setComputerOpen(false) }}
                title="Toggle artifacts panel"
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] border transition ${
                  artifactsOpen
                    ? 'border-white/15 text-slate-200 bg-white/[0.08]'
                    : 'border-white/[0.06] text-slate-500 hover:bg-white/[0.05] hover:text-slate-300'
                }`}
              >
                <FileDown size={13} />
                <span className="hidden sm:inline">Files</span>
                <span className="text-slate-600">{allArtifacts.length}</span>
              </button>
            )}
            {currentConversationId && (
              <button
                onClick={() => setResearchOpen((v) => !v)}
                title="Research runs"
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] border transition ${
                  researchOpen
                    ? 'border-white/15 text-slate-200 bg-white/[0.08]'
                    : 'border-white/[0.06] text-slate-500 hover:bg-white/[0.05] hover:text-slate-300'
                }`}
              >
                <FlaskConical size={13} />
                <span className="hidden sm:inline">Research</span>
              </button>
            )}
            <button
              onClick={() => (computerOpen ? setComputerOpen(false) : openComputer())}
              title="Toggle Activity panel"
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] border transition ${
                computerOpen
                  ? 'border-white/15 text-slate-200 bg-white/[0.08]'
                  : 'border-white/[0.06] text-slate-500 hover:bg-white/[0.05] hover:text-slate-300'
              }`}
            >
              <Cpu size={13} />
              <span className="hidden sm:inline">Activity</span>
            </button>
          </div>
        </div>

        {/* Messages */}
        <MessageList
          messages={messages}
          liveUser={liveUser}
          liveSteps={liveSteps}
          liveAnswer={liveAnswer}
          liveArtifacts={liveArtifacts}
          onStartPrompt={(prompt) => { setInput(prompt); setTimeout(() => document.querySelector('textarea')?.focus(), 100) }}
          running={running}
          statusMsg={statusMsg}
          mode={mode}
          computerOpen={computerOpen}
          onOpenComputer={openComputer}
          onEditMessage={(content) => setInput(content)}
          onRetryBefore={retryBefore}
        />

        {/* Composer */}
        <div className="border-t border-white/[0.05] px-3 sm:px-4 py-3 sm:py-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-[#111113]">
          <div className="max-w-[48rem] mx-auto">
            <Composer
              input={input}
              imagePreviews={imagePreviews}
              running={running}
              runMode={runMode}
              showSlash={showSlash}
              showPlus={showPlus}
              showModeMenu={showModeMenu}
              onInputChange={handleInputChange}
              onSelectSlashCommand={handleSlashCommand}
              onSend={handleSend}
              onStop={stopRun}
              onImagesSelected={handleImagesSelected}
              onRemoveImage={(i) => {
                setSelectedImages((prev) => prev.filter((_, idx) => idx !== i))
                setImagePreviews((prev) => prev.filter((_, idx) => idx !== i))
              }}
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

      {/* ── Right: Activity panel ─────────────────────────────────────────── */}
      <AnimatePresence initial={false}>
        {artifactsOpen && !computerOpen && (
          <ArtifactsPanel artifacts={allArtifacts} onClose={() => setArtifactsOpen(false)} />
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {computerOpen && (
          <ActivityPanel
            running={running}
            status={statusMsg}
            steps={liveSteps}
            artifacts={liveArtifacts}
            toolCount={toolCount}
            pendingApproval={pendingApproval}
            onApprove={() => { pendingApproval?.approve(true).then(() => setPendingApproval(null)) }}
            onDeny={() => { pendingApproval?.approve(false).then(() => setPendingApproval(null)) }}
            onClose={() => setComputerOpen(false)}
            onOpenTools={() => { setSettingsTab('tools'); setShowSettings(true) }}
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
onNewSession={() => { setCurrentConversationId(null); setSidebarOpen(false) }}
onToggleSidebar={() => setSidebarOpen((s) => !s)}
        onOpenSettings={() => { setSettingsTab(undefined); setShowSettings(true) }}
        onLogout={() => { logout(); setSidebarOpen(false) }}
      />
      <ShortcutSheet />
      <button
        type="button"
        aria-label="Keyboard shortcuts"
        onClick={() => { /* The ShortcutSheet catches '?' key; this button is a visual hint */ }}
        className="fixed bottom-4 right-4 z-30 p-2 rounded-lg text-slate-600 hover:text-slate-400 hover:bg-white/[0.04] transition text-[12px] font-mono"
        title="Keyboard shortcuts (?)"
      >
        ⌘K ?
      </button>
    </div>
  )
}
