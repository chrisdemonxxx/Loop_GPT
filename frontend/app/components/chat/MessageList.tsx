'use client'

import { useEffect, useRef, useState } from 'react'
import { Copy, Check, Edit2, RotateCcw, FileDown, Loader2, Sparkles } from 'lucide-react'
import { motion } from 'framer-motion'
import { API_URL, type AgentMode } from '../../lib/api'
import { type ArtifactRef } from '../../lib/stream'
import Markdown from './Markdown'
import type { LiveStep } from '../AgentComputer'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  imageUrl?: string
  imagePath?: string
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
                  <div className="flex items-center gap-2 text-[13px] text-slate-500">
                    <span className="shimmer inline-block h-2.5 w-28 rounded-full" />
                    <span>{statusMsg}</span>
                  </div>
                )}
                {liveAnswer && (
                  <div className={running ? 'cursor' : ''}>
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
    <div className="flex gap-1.5 py-2">
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
  const artifacts: ArtifactRef[] = message.metadata?.artifacts || []
  const sources = message.metadata?.sources as { index: number; title: string; url: string }[] | undefined

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
          {message.imagePath && (
            <img
              src={message.imageUrl || `${API_URL}/uploads/${message.imagePath.split('/').pop()}`}
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
          {artifacts.map((a) => <ArtifactCard key={a.id} a={a} />)}
        </div>
      )}

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

      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity -ml-1">
        <ActionBtn onClick={copy} title="Copy" icon={copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />} />
        {onRetry && <ActionBtn onClick={onRetry} title="Retry" icon={<RotateCcw size={14} />} />}
      </div>
    </motion.div>
  )
}

function ActionBtn({ onClick, title, icon }: { onClick: () => void; title: string; icon: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="p-1.5 rounded-md text-slate-500 hover:text-slate-300 hover:bg-white/[0.05] transition"
    >
      {icon}
    </button>
  )
}

function ArtifactCard({ a }: { a: ArtifactRef }) {
  const href = a.url ? (a.url.startsWith('http') ? a.url : `${API_URL}${a.url}`) : undefined
  if (a.kind === 'image' && href) {
    return <img src={href} alt={a.name} className="max-w-md max-h-96 rounded-2xl border border-white/10" />
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-2 px-3 py-2 rounded-xl glass hover:border-white/15 hover:bg-white/[0.06] transition text-[13px]"
    >
      <FileDown size={14} className="text-[#c96442]" />
      <span className="text-slate-200">{a.name}</span>
      <span className="text-[10px] uppercase text-slate-500">{a.kind}</span>
    </a>
  )
}
