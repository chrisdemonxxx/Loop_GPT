'use client'

import { useState, useRef, useEffect } from 'react'
import { PanelLeft, FileDown, Cpu, Sparkles } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'

import { API_URL, authHeaders, getProviderSettings, getStoredUser, type AgentMode } from '../lib/api'
import { runAgentStream, type ArtifactRef } from '../lib/stream'
import SettingsPanel from '../components/SettingsPanel'
import { track } from '../components/Analytics'
import type { LiveStep } from '../components/AgentComputer'

import Sidebar from '../components/chat/Sidebar'
import Composer from '../components/chat/Composer'
import MessageList from '../components/chat/MessageList'
import ActivityPanel from '../components/chat/ActivityPanel'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  messageType?: string
  imageUrl?: string
  imagePath?: string
  toolUsed?: string
  metadata?: any
}
interface Conversation { id: string; title: string; createdAt: string; updatedAt: string }

function parseCommand(input: string): { mode: AgentMode; text: string } {
  const m = input.match(/^\/(research|chat|agent)\b[ \t]*/i)
  if (m) {
    const c = m[1].toLowerCase()
    return { mode: c === 'research' ? 'research' : c === 'chat' ? 'chat' : 'agent', text: input.slice(m[0].length) }
  }
  return { mode: 'agent', text: input }
}

export default function ChatPage() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [computerOpen, setComputerOpen] = useState(false)
  const [isDesktop, setIsDesktop] = useState(false)

  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<AgentMode>('agent')
  const [showSlash, setShowSlash] = useState(false)
  const [showPlus, setShowPlus] = useState(false)
  const [showModeMenu, setShowModeMenu] = useState(false)
  const [runMode, setRunMode] = useState<'auto' | 'plan' | 'accept'>('auto')
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined)

  const [selectedImage, setSelectedImage] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)

  const [running, setRunning] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [liveUser, setLiveUser] = useState<{ content: string; image?: string } | null>(null)
  const [liveSteps, setLiveSteps] = useState<LiveStep[]>([])
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
    if (getStoredUser() || localStorage.getItem('token')) return
    fetch(`${API_URL}/api/auth/providers`)
      .then((r) => r.json())
      .then((d) => { if (!d.guest) window.location.href = '/login' })
      .catch(() => {})
  }, [])

  // ── Helpers ───────────────────────────────────────────────────────────────
  const openComputer = () => { setComputerOpen(true); if (!isDesktop) setSidebarOpen(false) }
  const closeOverlays = () => { if (!isDesktop) { setSidebarOpen(false); setComputerOpen(false) } }

  function selectConversation(id: string | null) {
    setCurrentConversationId(id)
    setLiveUser(null); setLiveSteps([]); setLiveArtifacts([]); setStatusMsg('')
  }

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
      return (await axios.post(`${API_URL}/api/conversations/${convId}/upload-image`, fd, { headers: authHeaders(false) })).data.imagePath
    } catch { return undefined }
  }

  async function handleSend(e?: React.FormEvent) {
    e?.preventDefault()
    if ((!input.trim() && !selectedImage) || running) return
    const { mode: sendMode, text: content } = parseCommand(input.trim())
    if (!content && !selectedImage) return

    setMode(sendMode)
    setShowSlash(false); setShowPlus(false); setShowModeMenu(false)
    const image = selectedImage
    const preview = imagePreview
    setInput(''); setSelectedImage(null); setImagePreview(null)
    setRunning(true); setStatusMsg(''); setLiveSteps([]); setLiveArtifacts([])
    autoOpenedRef.current = false
    setLiveUser({ content, image: preview || undefined })
    track('message_sent', { mode: sendMode })

    let convId: string | null = null
    try {
      convId = await ensureConversation(content)
      let imagePath: string | undefined
      if (image) imagePath = await uploadImage(convId, image)
      const { provider, model, apiKey } = getProviderSettings()
      const abort = new AbortController()
      abortRef.current = abort

      const sendContent = runMode === 'plan' && content
        ? `Plan first: briefly outline the steps you'll take, then carry them out.\n\n${content}`
        : content

      await runAgentStream(convId, { content: sendContent, imagePath, mode: sendMode, provider, model, apiKey }, {
        onStatus: (m) => { if (!m.startsWith('conversation:')) setStatusMsg(m) },
        onWarming: (m) => setStatusMsg(m),
        onDelta: (step, text) => {
          setStatusMsg('')
          setLiveSteps((prev) => {
            const next = [...prev]
            const i = next.findIndex((s) => s.index === step)
            if (i === -1) next.push({ index: step, kind: 'text', text })
            else if (next[i].kind === 'text') next[i] = { ...next[i], text: next[i].text + text }
            return next
          })
        },
        onToolCall: (step, name, args, source) => {
          setLiveSteps((prev) => {
            const next = [...prev]
            const i = next.findIndex((s) => s.index === step)
            const t: LiveStep = { index: step, kind: 'tool', text: '', tool: { name, args, source } }
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

  function handleImageSelected(file: File) {
    setSelectedImage(file)
    const r = new FileReader()
    r.onloadend = () => setImagePreview(r.result as string)
    r.readAsDataURL(file)
  }

  function handleInputChange(value: string) {
    setInput(value)
    setShowSlash(value.startsWith('/') && !/\s/.test(value))
  }

  function exportConversation() {
    const title = conversations.find((c) => c.id === currentConversationId)?.title || 'conversation'
    const md = messages.map((m) => `**${m.role === 'user' ? 'You' : 'Loop GPT'}**\n\n${m.content}`).join('\n\n---\n\n')
    const blob = new Blob([`# ${title}\n\n${md}`], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${title.replace(/[^a-z0-9]/gi, '-')}.md`; a.click()
    URL.revokeObjectURL(url)
  }

  function retryBefore(beforeIndex: number) {
    const userMsgs = messages.slice(0, beforeIndex).filter((m) => m.role === 'user')
    const last = userMsgs[userMsgs.length - 1]
    if (last?.content) setInput(last.content)
  }

  const liveAnswer = liveSteps.filter((s) => s.kind === 'text').map((s) => s.text).join('')
  const convTitle = conversations.find((c) => c.id === currentConversationId)?.title

  return (
    <div className="flex h-[100dvh] overflow-hidden text-slate-200 bg-[#111113]">
      {/* Mobile backdrop */}
      {(sidebarOpen || computerOpen) && !isDesktop && (
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
              onSelectConversation={(id) => { selectConversation(id); closeOverlays() }}
              onClose={() => setSidebarOpen(false)}
              onOpenSettings={() => setShowSettings(true)}
              onLogout={logout}
              onRenameConversation={(id, title) => updateConv.mutate({ id, title })}
              onDeleteConversation={(id) => deleteConv.mutate(id)}
            />
          </motion.aside>
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
            {messages.length > 0 && (
              <button
                onClick={exportConversation}
                title="Export conversation"
                className="p-1.5 rounded-lg hover:bg-white/[0.05] text-slate-500 hover:text-slate-300 transition"
              >
                <FileDown size={15} />
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
              imagePreview={imagePreview}
              running={running}
              runMode={runMode}
              showSlash={showSlash}
              showPlus={showPlus}
              showModeMenu={showModeMenu}
              onInputChange={handleInputChange}
              onSelectSlashCommand={(cmd) => { setInput(cmd); setShowSlash(false) }}
              onSend={handleSend}
              onStop={stopRun}
              onImageSelected={handleImageSelected}
              onRemoveImage={() => { setSelectedImage(null); setImagePreview(null) }}
              onTogglePlus={() => setShowPlus((v) => !v)}
              onClosePlus={() => setShowPlus(false)}
              onToggleModeMenu={() => setShowModeMenu((v) => !v)}
              onCloseModeMenu={() => setShowModeMenu(false)}
              onRunModeChange={setRunMode}
              onOpenConnectors={() => { setShowPlus(false); setSettingsTab('connectors'); setShowSettings(true) }}
            />
          </div>
        </div>
      </div>

      {/* ── Right: Activity panel ─────────────────────────────────────────── */}
      <AnimatePresence initial={false}>
        {computerOpen && (
          <ActivityPanel
            running={running}
            status={statusMsg}
            steps={liveSteps}
            artifacts={liveArtifacts}
            toolCount={toolCount}
            onClose={() => setComputerOpen(false)}
          />
        )}
      </AnimatePresence>

      {showSettings && (
        <SettingsPanel
          initialTab={settingsTab}
          onClose={() => { setShowSettings(false); setSettingsTab(undefined) }}
        />
      )}
    </div>
  )
}
