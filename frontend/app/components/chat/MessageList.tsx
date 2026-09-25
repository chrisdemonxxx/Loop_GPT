'use client'

import { useEffect, useRef } from 'react'
import { Loader2, Brain, FileText } from 'lucide-react'
import { motion } from 'framer-motion'
import { type AgentMode } from '../../lib/api'
import { type ArtifactRef } from '../../lib/stream'
import Markdown from './Markdown'
import type { LiveStep, Message, PendingApproval } from './types'
import { MessageBubble } from './MessageBubble'
import { EmptyState, ThinkingDots } from './EmptyState'
import { ArtifactCard } from './ArtifactCard'
import TurnActivity from './TurnActivity'

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
  /** Live-turn tool approval handshake (inline activity card). */
  pendingApproval?: PendingApproval | null
  onApprove?: () => void
  onDeny?: () => void
  toolCount?: number
  onOpenTools?: () => void
  onEditMessage: (messageId: string, content: string) => void
  onRetryBefore: (beforeIndex: number) => void
  onStartPrompt?: (prompt: string) => void
}

/** The conversation transcript: stored bubbles, the live user turn, and the
 * streaming assistant turn (thinking, status, answer, inline activity feed). */
export default function MessageList({
  messages, liveUser, liveSteps, liveAnswer, liveThinking, liveArtifacts,
  running, statusMsg, mode, pendingApproval, onApprove, onDeny, toolCount, onOpenTools,
  onEditMessage, onRetryBefore, onStartPrompt,
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
                {running && (mode === 'research' || mode === 'agent') && !liveAnswer && !liveSteps.some((s) => s.kind === 'tool') && (
                  <div className="flex items-center gap-2 text-[13px] text-slate-500">
                    <Loader2 size={12} className="animate-spin" />
                    <span>{statusMsg || 'working'}</span>
                  </div>
                )}
                {statusMsg && !liveAnswer && liveSteps.length === 0 && (
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
                {/* Inline agent activity: the per-step timeline for this turn
                    streams below the response (audit P1). */}
                <TurnActivity
                  running={running}
                  status={statusMsg}
                  liveSteps={liveSteps}
                  pendingApproval={pendingApproval}
                  onApprove={onApprove}
                  onDeny={onDeny}
                  onRetry={() => onRetryBefore(messages.length - 1)}
                  toolCount={toolCount}
                  onOpenTools={onOpenTools}
                />
                {!liveAnswer && !statusMsg && liveSteps.length === 0 && running && <ThinkingDots />}
              </div>
            </>
          )}

          <div ref={endRef} />
        </div>
      )}
    </div>
  )
}
