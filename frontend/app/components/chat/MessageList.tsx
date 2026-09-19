'use client'

import { useEffect, useRef, useState } from 'react'
import { Copy, Check, Edit2, RotateCcw, FileDown, Loader2, Sparkles, X, Maximize2 } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { API_URL, authHeaders, type AgentMode } from '../../lib/api'
import { type ArtifactRef } from '../../lib/stream'
import Markdown from './Markdown'
import type { LiveStep } from '../AgentComputer'

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
  liveUser: { content: string; image?: string } | null
  liveSteps: LiveStep[]
  liveAnswer: string
  liveArtifacts: ArtifactRef[]
  running: boolean
  statusMsg: string
  mode: AgentMode
  computerOpen: boolean
  onOpenComputer: () => void
  onEditMessage: (content: string) => void
  onRetryBefore: (beforeIndex: number) => void
}

export default function MessageList({
  messages, liveUser, liveSteps, liveAnswer, liveArtifacts,
  running, statusMsg, mode, computerOpen,
  onOpenComputer, onEditMessage, onRetryBefore,
}: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null)
  const showEmpty = messages.length === 0 && !liveUser

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, liveSteps, statusMsg, liveAnswer])

  return (
    <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 sm:py-8 min-h-0">
      {showEmpty ? (
        <EmptyState />
      ) : (
        <div className="max-w-[48rem] mx-auto space-y-6">
          {messages.map((m, idx) => (
            <MessageBubble
              key={m.id}
              message={m}
              onEdit={m.role === 'user' ? () => onEditMessage(m.content) : undefined}
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
                  {liveUser.image && (
                    <img
                      src={liveUser.image}
                      alt="upload"
                      className="max-w-[240px] max-h-52 rounded-xl border border-white/10 mb-2.5"
                    />
                  )}
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

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full max-w-[48rem] mx-auto text-center px-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        className="space-y-3"
      >
        <div className="w-10 h-10 rounded-2xl bg-[#c96442]/12 border border-[#c96442]/20 flex items-center justify-center mx-auto">
          <Sparkles size={18} className="text-[#c96442]" />
        </div>
        <h1 className="text-2xl sm:text-[28px] font-semibold tracking-tight text-slate-100">
          How can I help you today?
        </h1>
        <p className="text-slate-500 text-[14px] max-w-xs">
          Ask anything. Type{' '}
          <span className="font-mono text-slate-400 bg-white/[0.05] px-1.5 py-0.5 rounded text-[13px]">
            /
          </span>{' '}
          for commands like deep research.
        </p>
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
  const artifacts: ArtifactRef[] = message.metadata?.artifacts || []
  const sources = message.metadata?.sources as { index: number; title: string; url: string }[] | undefined
  const attachedImage = useAttachmentUrl(message.attachmentId)

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
      {message.content && <Markdown content={message.content} />}

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

function ArtifactCard({ a, onOpen }: { a: ArtifactRef; onOpen?: () => void }) {
  const href = a.url ? (a.url.startsWith('http') ? a.url : `${API_URL}${a.url}`) : undefined
  const imageSrc = useAuthedUrl(a.kind === 'image' ? href : undefined)
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
  const isImage = a.kind === 'image'
  const isMarkdown = /\.(md|txt)$/i.test(a.name) || a.kind === 'document'
  const [textContent, setTextContent] = useState<string | null>(null)
  useEffect(() => {
    if (isImage || !href) return
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
  }, [href, isImage])
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
          {isImage && viewerImage && <img src={viewerImage} alt={a.name} className="max-w-full rounded-xl border border-white/10" />}
          {!isImage && textContent !== null && (isMarkdown
            ? <Markdown content={textContent} />
            : <pre className="text-[13px] leading-relaxed text-slate-200 whitespace-pre-wrap font-mono">{textContent}</pre>)}
          {!isImage && textContent === null && (
            <div className="flex items-center gap-2 text-slate-500 text-[13px] py-8 justify-center">
              <Loader2 size={14} className="animate-spin" /> Loading preview…
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}
