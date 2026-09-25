'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Copy, Check, Edit2, RotateCcw, FileDown, FileText, Loader2, Sparkles, X, Maximize2, Volume2, Pause, Square, Brain } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { API_URL, authHeaders, type AgentMode } from '../../lib/api'
import { type ArtifactRef } from '../../lib/stream'
import Markdown from './Markdown'
import type { LiveStep } from '../AgentComputer'
import { useSpeech } from '../../lib/voice'

/** Resolve a private attachment to a local object URL via the authenticated
 * content endpoint. The retired public /uploads path is never used. */
function useAttachmentUrl(attachmentId?: string): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let objectUrl: string | null = null
    let revoked = false
    if (!attachmentId) { setUrl(null); return }
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/files/${attachmentId}/content`, { headers: authHeaders(false) })
        if (!res.ok) return
        const blob = await res.blob()
        if (revoked) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      } catch { /* offline or expired: leave the placeholder */ }
    })()
    return () => { revoked = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [attachmentId])
  return url
}

/** Authed artifact URL → object URL. Artifact refs point at the auth-only
 * content endpoint; a raw <img src>/href would 401 (the reported bug).
 * Same proven pattern as useAttachmentUrl, for any authed href. */
function useAuthedUrl(href: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let objectUrl: string | null = null
    let revoked = false
    if (!href || href.startsWith('blob:')) { setUrl(href ?? null); return }
    if (!href.startsWith(`${API_URL}/api/files/`) && !href.startsWith('/api/files/')) { setUrl(href); return }
    (async () => {
      try {
        const res = await fetch(href.startsWith('http') ? href : `${API_URL}${href}`, { headers: authHeaders(false) })
        if (!res.ok) return
        const blob = await res.blob()
        if (revoked) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      } catch { /* leave the fallback affordance */ }
    })()
    return () => { revoked = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [href])
  return url
}

/** Authed download: fetch with the session token, then hand the browser a
 * correctly named, correct-MIME file. Never a raw href on auth-only URLs. */
async function downloadArtifact(a: ArtifactRef, href?: string | null) {
  if (!href) return
  try {
    const res = await fetch(href.startsWith('http') ? href : `${API_URL}${href}`, { headers: authHeaders(false) })
    if (!res.ok) return
    const blob = await res.blob()
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = a.name || 'artifact'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(objectUrl)
  } catch { /* offline or expired */ }
}

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  imageUrl?: string
  attachmentId?: string
  messageType?: string
  toolUsed?: string
  metadata?: any
}

interface MessageListProps {
  messages: Message[]
  liveUser: { content: string; image?: string; images?: string[]; docs?: string[] } | null
  liveSteps: LiveStep[]
  liveAnswer: string
  /** Extended thinking (§2.5): reasoning stream for the live assistant turn. */
  liveThinking?: string
  liveArtifacts: ArtifactRef[]
  running: boolean
  statusMsg: string
  mode: AgentMode
  computerOpen: boolean
  onOpenComputer: () => void
  onEditMessage: (messageId: string, content: string) => void
  onRetryBefore: (beforeIndex: number) => void
  onStartPrompt?: (prompt: string) => void
}

export default function MessageList({
  messages, liveUser, liveSteps, liveAnswer, liveThinking, liveArtifacts,
  running, statusMsg, mode,   computerOpen,
  onOpenComputer, onEditMessage, onRetryBefore, onStartPrompt,
}: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null)
  const showEmpty = messages.length === 0 && !liveUser

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, liveSteps, statusMsg, liveAnswer])

  return (
    <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 sm:py-8 min-h-0">
      {showEmpty ? (
        <EmptyState onStartPrompt={onStartPrompt} />
      ) : (
        <div className="max-w-[48rem] mx-auto space-y-6">
          {messages.map((m, idx) => (
            <MessageBubble
              key={m.id}
              message={m}
              onEdit={m.role === 'user' ? () => onEditMessage(m.id, m.content) : undefined}
              onRetry={m.role === 'assistant' ? () => onRetryBefore(idx) : undefined}
            />
          ))}

          {/* Live user message */}
          {liveUser && (
            <>
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex justify-end"
              >
                <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-[#1e1e21] border border-white/[0.07] px-4 py-3">
                  {(liveUser.images?.length || liveUser.image) && (
                    <div className="flex flex-wrap gap-2 mb-2.5">
                      {(liveUser.images?.length ? liveUser.images : liveUser.image ? [liveUser.image] : []).map((src, i) => (
                        <img
                          key={i}
                          src={src}
                          alt={`upload ${i + 1}`}
                          className="max-w-[180px] max-h-40 rounded-xl border border-white/10"
                        />
                      ))}
                    </div>
                  )}
                  {liveUser.docs?.length ? (
                    <div className="flex flex-wrap gap-1.5 mb-2.5">
                      {liveUser.docs.map((name) => (
                        <span key={name} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-white/10 bg-white/[0.04] text-[11px] text-slate-300">
                          <FileText size={11} className="text-slate-400" /> {name}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="whitespace-pre-wrap text-slate-100 text-[15px] leading-relaxed">
                    {liveUser.content}
                  </div>
                </div>
              </motion.div>

              {/* In-run artifacts render in the flow, not only after reload */}
          {liveArtifacts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {liveArtifacts.map((a) => <ArtifactCard key={a.id} a={a} />)}
            </div>
          )}

          {/* Live assistant response */}
              <div className="min-w-0 space-y-2">
                {/* Extended thinking (§2.5): collapsible reasoning stream. */}
                {liveThinking && (
                  <details className="group rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden" open={running && !liveAnswer}>
                    <summary className="flex items-center gap-1.5 px-3 py-2 text-[12px] text-slate-400 cursor-pointer hover:text-slate-200 select-none">
                      <Brain size={12} className="text-slate-500" />
                      <span>{running && !liveAnswer ? 'Thinking…' : 'Thoughts'}</span>
                      {running && !liveAnswer && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse ml-0.5" />}
                    </summary>
                    <div className={`px-3.5 pb-3 text-[12.5px] leading-relaxed text-slate-500 whitespace-pre-wrap max-h-64 overflow-y-auto ${running && !liveAnswer ? 'shimmer-text' : ''}`}>
                      {liveThinking}
                    </div>
                  </details>
                )}
                {running && (mode === 'research' || mode === 'agent') && !liveAnswer && (
                  <button
                    onClick={computerOpen ? undefined : onOpenComputer}
                    className="inline-flex items-center gap-1.5 text-[12px] text-slate-500 hover:text-slate-300 transition"
                  >
                    <Loader2 size={12} className="animate-spin" />
                    <span>{statusMsg || 'working'}</span>
                    {!computerOpen && <span className="text-slate-600">· view activity</span>}
                  </button>
                )}
                {statusMsg && !liveAnswer && (
                  <div className="flex items-center gap-2 text-[13px] text-slate-500" aria-live="polite">
                    <span className="shimmer inline-block h-2.5 w-28 rounded-full" aria-hidden="true" />
                    <span>{statusMsg}</span>
                  </div>
                )}
                {liveAnswer && (
                  <div className={running ? 'cursor' : ''} aria-live="polite">
                    <Markdown content={liveAnswer} />
                  </div>
                )}
                {!liveAnswer && !statusMsg && running && <ThinkingDots />}
              </div>
            </>
          )}

          <div ref={endRef} />
        </div>
      )}
    </div>
  )
}

const STARTER_PROMPTS = [
  'Explain quantum computing like I’m 10',
  'Write a Python script to plot a sine wave',
  'Summarise the latest AI research trends',
  'Draft a business plan for a SaaS startup',
] as const

function EmptyState({ onStartPrompt }: { onStartPrompt?: (p: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full max-w-[48rem] mx-auto text-center px-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        className="space-y-4"
      >
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#c96442]/20 to-[#c96442]/8 flex items-center justify-center mx-auto">
          <Sparkles size={22} className="text-gradient" />
        </div>
        <h1 className="text-2xl sm:text-[28px] font-semibold tracking-tight text-gradient">
          How can I help you today?
        </h1>
        <p className="text-slate-500 text-[14px] max-w-sm mx-auto">
          Type <span className="font-mono text-slate-400 bg-white/[0.05] px-1.5 py-0.5 rounded text-[13px]">/</span> for
          deep research. <span className="font-mono text-slate-400 bg-white/[0.05] px-1.5 py-0.5 rounded text-[13px]">⌘K</span> for commands.
          New here? <Link href="/onboarding" className="text-[#e79d7f] hover:underline">Take the 2-minute tour →</Link>
        </p>

        {/* Starter prompt cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mt-6 max-w-md mx-auto">
          {STARTER_PROMPTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onStartPrompt?.(p)}
              className="text-left px-4 py-3 rounded-2xl glass bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] hover:border-white/12 transition text-[13px] text-slate-300 hover:text-slate-100 leading-relaxed"
            >
              {p}
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  )
}

function ThinkingDots() {
  return (
    <div className="flex gap-1.5 py-2" role="status" aria-label="Thinking">
      {[0, 150, 300].map((d) => (
        <span
          key={d}
          className="w-1.5 h-1.5 rounded-full bg-slate-500/60 animate-bounce"
          style={{ animationDelay: `${d}ms` }}
        />
      ))}
    </div>
  )
}

function MessageBubble({
  message, onEdit, onRetry,
}: {
  message: Message
  onEdit?: () => void
  onRetry?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [viewer, setViewer] = useState<ArtifactRef | null>(null)
  const [showPrompt, setShowPrompt] = useState(false)
  const artifacts: ArtifactRef[] = message.metadata?.artifacts || []
  const sources = message.metadata?.sources as { index: number; title: string; url: string }[] | undefined
  const promptMeta = message.metadata?.prompt as { raw: string; enhanced: string; optimized: boolean } | undefined
  const attachedImage = useAttachmentUrl(message.attachmentId)
  const speech = useSpeech()

  const copy = () => {
    navigator.clipboard?.writeText(message.content || '').then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    })
  }

  if (message.role === 'user') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        className="group flex flex-col items-end gap-1"
      >
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-[#1e1e21] border border-white/[0.07] px-4 py-3">
          {(attachedImage || message.imageUrl) && (
            <img
              src={attachedImage || message.imageUrl}
              alt="Uploaded"
              className="max-w-[280px] max-h-64 rounded-xl border border-white/10 mb-2.5"
            />
          )}
          {message.content && (
            <div className="whitespace-pre-wrap text-slate-100 text-[15px] leading-relaxed">
              {message.content}
            </div>
          )}
        </div>
        {onEdit && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity pr-1">
            <ActionBtn onClick={onEdit} title="Edit" icon={<Edit2 size={13} />} />
            <ActionBtn onClick={copy} title="Copy" icon={copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />} />
          </div>
        )}
      </motion.div>
    )
  }

  // Assistant message
  return (
    <motion.div
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="group space-y-3"
    >
      {/* Stored extended thinking (§2.5): survives reloads via message metadata. */}
      {message.metadata?.reasoning && (
        <details className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
          <summary className="flex items-center gap-1.5 px-3 py-2 text-[12px] text-slate-400 cursor-pointer hover:text-slate-200 select-none">
            <Brain size={12} className="text-slate-500" /> Thoughts
          </summary>
          <div className="px-3.5 pb-3 text-[12.5px] leading-relaxed text-slate-500 whitespace-pre-wrap max-h-64 overflow-y-auto">
            {String(message.metadata.reasoning)}
          </div>
        </details>
      )}
      {message.content && <Markdown content={message.content} />}

      {promptMeta?.optimized && (
        <div className="text-[12px]">
          <button
            type="button"
            onClick={() => setShowPrompt((v) => !v)}
            className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-300 transition"
            aria-expanded={showPrompt}
          >
            <Sparkles size={11} /> {showPrompt ? 'Hide' : 'View'} enhanced prompt
          </button>
          {showPrompt && (
            <div className="mt-1.5 rounded-xl border border-white/[0.07] bg-white/[0.03] p-3 space-y-2">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">Original</div>
                <div className="text-slate-400 whitespace-pre-wrap">{promptMeta.raw}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">Enhanced (sent to the model)</div>
                <div className="text-slate-200 whitespace-pre-wrap">{promptMeta.enhanced}</div>
              </div>
            </div>
          )}
        </div>
      )}

      {artifacts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {artifacts.map((a) => <ArtifactCard key={a.id} a={a} onOpen={() => setViewer(a)} />)}
        </div>
      )}
      <AnimatePresence>{viewer && <ArtifactViewer a={viewer} onClose={() => setViewer(null)} />}</AnimatePresence>

      {sources && sources.length > 0 && (
        <div className="text-[12px] text-slate-500 space-y-1">
          <div className="font-medium text-slate-400 text-[12px]">Sources</div>
          <ol className="space-y-0.5">
            {sources.map((s) => (
              <li key={s.index}>
                [{s.index}]{' '}
                <a href={s.url} target="_blank" rel="noreferrer" className="text-sky-400/80 hover:text-sky-400 hover:underline">
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity -ml-1">
        <ActionBtn onClick={copy} title="Copy" ariaLabel="Copy message" icon={copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />} />
        {speech.supported && message.content && (
          <>
            <ActionBtn
              onClick={() => speech.speak(message.id, message.content)}
              title={speech.speakingId === message.id ? (speech.paused ? 'Resume reading' : 'Pause reading') : 'Read aloud'}
              ariaLabel="Read aloud"
              icon={<Volume2 size={14} className={speech.speakingId === message.id ? 'text-[#c96442]' : undefined} />}
            />
            {speech.speakingId === message.id && (
              <>
                <ActionBtn onClick={speech.pauseOrResume} title={speech.paused ? 'Resume' : 'Pause'} ariaLabel={speech.paused ? 'Resume' : 'Pause'} icon={<Pause size={14} />} />
                <ActionBtn onClick={speech.stop} title="Stop reading" ariaLabel="Stop reading" icon={<Square size={13} />} />
              </>
            )}
          </>
        )}
        {onRetry && <ActionBtn onClick={onRetry} title="Retry" ariaLabel="Retry response" icon={<RotateCcw size={14} />} />}
      </div>
    </motion.div>
  )
}

function ActionBtn({ onClick, title, ariaLabel, icon }: { onClick: () => void; title: string; ariaLabel?: string; icon: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={ariaLabel || title}
      className="p-1.5 rounded-md text-slate-500 hover:text-slate-300 hover:bg-white/[0.05] transition"
    >
      {icon}
    </button>
  )
}

function isVideoArtifact(a: ArtifactRef) {
  return a.kind === 'video' || (a.mimeType || '').startsWith('video/') || /\.(mp4|webm|mov)$/i.test(a.name)
}

function ArtifactCard({ a, onOpen }: { a: ArtifactRef; onOpen?: () => void }) {
  const href = a.url ? (a.url.startsWith('http') ? a.url : `${API_URL}${a.url}`) : undefined
  const imageSrc = useAuthedUrl(a.kind === 'image' ? href : undefined)
  const videoSrc = useAuthedUrl(isVideoArtifact(a) ? href : undefined)
  if (isVideoArtifact(a) && videoSrc) {
    return (
      <div className="group relative inline-flex max-w-md">
        <video
          src={videoSrc}
          controls
          playsInline
          preload="metadata"
          className="w-full max-h-96 rounded-2xl border border-white/10 bg-black"
        >
          <track kind="captions" />
        </video>
        <button
          type="button"
          onClick={() => downloadArtifact(a, href)}
          title="Download"
          aria-label={`Download ${a.name}`}
          className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 text-slate-200 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition"
        >
          <FileDown size={14} />
        </button>
      </div>
    )
  }
  if (a.kind === 'image' && imageSrc) {
    return (
      <div className="group relative inline-flex">
        <button type="button" onClick={onOpen} className="block group relative">
          <img src={imageSrc} alt={a.name} className="max-w-md max-h-96 rounded-2xl border border-white/10 group-hover:border-white/20 transition" />
          <span className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/50 text-slate-300 opacity-0 group-hover:opacity-100 transition">
            <Maximize2 size={13} />
          </span>
        </button>
        <button
          type="button"
          onClick={() => downloadArtifact(a, href)}
          title="Download"
          aria-label={`Download ${a.name}`}
          className="absolute bottom-2 right-2 p-1.5 rounded-lg bg-black/50 text-slate-300 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition"
        >
          <FileDown size={13} />
        </button>
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={() => downloadArtifact(a, href)}
      className="inline-flex items-center gap-2 px-3 py-2 rounded-xl glass hover:border-white/15 hover:bg-white/[0.06] transition text-[13px] text-left"
    >
      <FileDown size={14} className="text-[#c96442] shrink-0" />
      <span className="min-w-0">
        <span className="block text-slate-200 truncate">{a.name}</span>
        <span className="block text-[10px] uppercase text-slate-500">{a.kind}</span>
      </span>
    </button>
  )
}

/** Fullscreen in-app artifact viewer: images zoom, code/markdown render. */
function ArtifactViewer({ a, onClose }: { a: ArtifactRef; onClose: () => void }) {
  const href = a.url ? (a.url.startsWith('http') ? a.url : `${API_URL}${a.url}`) : undefined
  const viewerImage = useAuthedUrl(a.kind === 'image' ? href : undefined)
  const viewerVideo = useAuthedUrl(isVideoArtifact(a) ? href : undefined)
  const isImage = a.kind === 'image'
  const isVideo = isVideoArtifact(a)
  const isMarkdown = /\.(md|txt)$/i.test(a.name) || a.kind === 'document'
  const [textContent, setTextContent] = useState<string | null>(null)
  useEffect(() => {
    if (isImage || isVideo || !href) return
    let revoked = false
    ;(async () => {
      try {
        const res = await fetch(href, { headers: authHeaders(false) })
        if (!res.ok) return
        const text = await res.text()
        if (!revoked) setTextContent(text.slice(0, 512_000))
      } catch { /* leave the download affordance */ }
    })()
    return () => { revoked = true }
  }, [href, isImage, isVideo])
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 sm:p-8"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.97, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, y: 8 }} transition={{ duration: 0.16 }}
        role="dialog" aria-modal="true" aria-label={a.name}
        ref={(node) => { if (node) (node as HTMLElement).focus() }}
        tabIndex={-1}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
        className="max-w-4xl w-full max-h-full glass rounded-2xl border border-white/10 overflow-hidden flex flex-col outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div className="min-w-0">
            <div className="text-[14px] text-slate-100 truncate">{a.name}</div>
            <div className="text-[11px] uppercase tracking-wide text-slate-500">{a.kind}</div>
          </div>
          <div className="flex items-center gap-2">
            {href && (
              <button type="button" onClick={() => downloadArtifact(a, href)}
                title="Download" aria-label={`Download ${a.name}`}
                className="p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-white/[0.05] transition">
                <FileDown size={15} />
              </button>
            )}
            <button type="button" onClick={onClose}
              className="p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-white/[0.05] transition">
              <X size={15} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {isVideo && viewerVideo && (
            <video src={viewerVideo} controls playsInline preload="metadata"
              className="max-w-full rounded-xl border border-white/10 bg-black">
              <track kind="captions" />
            </video>
          )}
          {isImage && viewerImage && <img src={viewerImage} alt={a.name} className="max-w-full rounded-xl border border-white/10" />}
          {!isImage && !isVideo && textContent !== null && (isMarkdown
            ? <Markdown content={textContent} />
            : <pre className="text-[13px] leading-relaxed text-slate-200 whitespace-pre-wrap font-mono">{textContent}</pre>)}
          {!isImage && !isVideo && textContent === null && (
            <div className="flex items-center gap-2 text-slate-500 text-[13px] py-8 justify-center">
              <Loader2 size={14} className="animate-spin" /> Loading preview…
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}
