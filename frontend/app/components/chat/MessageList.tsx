'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, Brain, FileText, ArrowDown } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import { type AgentMode } from '../../lib/api'
import { type ArtifactRef } from '../../lib/stream'
import { type BranchVersionInfo } from '../../lib/branch'
import Markdown from './Markdown'
import type { LiveStep, Message, PendingApproval } from './types'
import { MessageBubble } from './MessageBubble'
import { EmptyState, ThinkingDots } from './EmptyState'
import { ArtifactCard } from './ArtifactCard'
import TurnActivity from './TurnActivity'

/** Stored-history virtualization threshold (audit §8-33): below it the
 * transcript renders normally (no measurement overhead, zero behavior
 * change); above it, TanStack Virtual bounds the DOM to the visible window
 * so long conversations stop growing it unboundedly. The live streaming
 * turn always renders in normal flow — no measurement jitter mid-stream. */
const VIRTUALIZE_ABOVE = 100

interface MessageListProps {
  messages: Message[]
  /** For feedback submission (audit §8-21). */
  conversationId?: string | null
  liveUser: { content: string; image?: string; images?: string[]; docs?: string[] } | null
  liveSteps: LiveStep[]
  liveAnswer: string
  /** Extended thinking (§2.5): reasoning stream for the live assistant turn. */
  liveThinking?: string
  liveArtifacts: ArtifactRef[]
  /** §8-22: while a retry/edit run streams, the stored transcript truncates
   * at this row (inclusive) and the live turn renders in its place. */
  liveReplaceAfterId?: string | null
  /** §8-22 version-arrow data per displayed row (rows with siblings only). */
  versions?: Record<string, BranchVersionInfo>
  /** §8-22: switch the active path to a sibling version row. */
  onSelectVersion?: (messageId: string) => void
  running: boolean
  statusMsg: string
  mode: AgentMode
  /** Live-turn tool approval handshake (inline activity card). */
  pendingApproval?: PendingApproval | null
  onApprove?: () => void
  onDeny?: () => void
  toolCount?: number
  onOpenTools?: () => void
  /** Artifact cards open the right-hand panel focused on the artifact (P2). */
  onOpenArtifact?: (artifact: ArtifactRef) => void
  /** §8-28: per-step "View in panel" links resolve artifact names here. */
  onOpenArtifactByName?: (name: string) => void
  onEditMessage: (messageId: string, content: string) => void
  onRetryBefore: (beforeIndex: number) => void
  onStartPrompt?: (prompt: string) => void
}

/** The conversation transcript: stored bubbles, the live user turn, and the
 * streaming assistant turn (thinking, status, answer, inline activity feed).
 * Auto-scroll only while the reader is at the bottom (scroll-fight
 * protection, audit §8-18); otherwise a floating jump-to-bottom button. */
export default function MessageList({
  messages, conversationId, liveUser, liveSteps, liveAnswer, liveThinking, liveArtifacts, liveReplaceAfterId,
  versions, onSelectVersion,
  running, statusMsg, mode, pendingApproval, onApprove, onDeny, toolCount, onOpenTools,
  onOpenArtifact, onOpenArtifactByName, onEditMessage, onRetryBefore, onStartPrompt,
}: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  // §8-22: a branched (retry/edit) live run replaces everything after its
  // anchor — the old version swaps out while the new one streams in place.
  const anchorIndex = liveReplaceAfterId ? messages.findIndex((m) => m.id === liveReplaceAfterId) : -1
  const visible = anchorIndex >= 0 ? messages.slice(0, anchorIndex + 1) : messages
  const showEmpty = visible.length === 0 && !liveUser
  const virtualize = visible.length > VIRTUALIZE_ABOVE

  // Virtualized window over the stored history (§8-33): dynamic row
  // measurement (ResizeObserver via measureElement), overscan keeps scroll-up
  // smooth. The live turn + the end sentinel stay OUTSIDE the window.
  const virtualizer = useVirtualizer({
    count: virtualize ? visible.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 220,
    overscan: 10,
    enabled: virtualize,
  })

  /** True when the reader is within ~160px of the bottom. */
  const measureBottom = () => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 160
  }
  const onScroll = () => setAtBottom(measureBottom())

  const jumpToBottom = () => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
    setAtBottom(true)
  }

  // Auto-scroll on new content ONLY while the reader is at the bottom —
  // scrolling up to read history wins over incoming content (no fighting).
  useEffect(() => {
    if (atBottom) endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, liveSteps, statusMsg, liveAnswer])

  return (
    <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 sm:py-8 min-h-0 relative"
      ref={scrollRef}
      onScroll={onScroll}
    >
      {showEmpty ? (
        <EmptyState onStartPrompt={onStartPrompt} />
      ) : (
        <div className="max-w-[48rem] mx-auto space-y-6">
          {virtualize ? (
            /* Virtualized history window (§8-33): absolutely positioned,
               dynamically measured rows inside a total-size container. */
            <div
              data-testid="virtual-window"
              style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}
            >
              {virtualizer.getVirtualItems().map((vi) => {
                const m = visible[vi.index]
                return (
                  <div
                    key={m.id}
                    data-index={vi.index}
                    ref={virtualizer.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                    className="pb-6"
                  >
                    <MessageBubble
                      message={m}
                      conversationId={conversationId}
                      onOpenArtifact={onOpenArtifact}
                      onOpenArtifactByName={onOpenArtifactByName}
                      version={versions?.[m.id]}
                      onSelectVersion={onSelectVersion}
                      onEdit={m.role === 'user' ? () => onEditMessage(m.id, m.content) : undefined}
                      onRetry={m.role === 'assistant' ? () => onRetryBefore(vi.index) : undefined}
                    />
                  </div>
                )
              })}
            </div>
          ) : (
            visible.map((m, idx) => (
              <MessageBubble
                key={m.id}
                message={m}
                conversationId={conversationId}
                onOpenArtifact={onOpenArtifact}
                onOpenArtifactByName={onOpenArtifactByName}
                version={versions?.[m.id]}
                onSelectVersion={onSelectVersion}
                onEdit={m.role === 'user' ? () => onEditMessage(m.id, m.content) : undefined}
                onRetry={m.role === 'assistant' ? () => onRetryBefore(idx) : undefined}
              />
            ))
          )}

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
                  {liveArtifacts.map((a) => <ArtifactCard key={a.id} a={a} onOpen={onOpenArtifact ? () => onOpenArtifact(a) : undefined} />)}
                </div>
              )}

              {/* Live assistant response */}
              <div className="min-w-0 space-y-2">
                {/* Extended thinking (§2.5): collapsible reasoning stream. */}
                {liveThinking && (
                  <details className="group rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden" open={running && !liveAnswer}>
                    <summary className="flex items-center gap-1.5 px-3 py-2 text-[12px] text-slate-400 cursor-pointer hover:text-slate-200 select-none">
                      <Brain size={12} className="text-slate-400" />
                      <span>{running && !liveAnswer ? 'Thinking…' : 'Thoughts'}</span>
                      {running && !liveAnswer && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse ml-0.5" />}
                    </summary>
                    <div className={`px-3.5 pb-3 text-[12.5px] leading-relaxed text-slate-400 whitespace-pre-wrap max-h-64 overflow-y-auto ${running && !liveAnswer ? 'shimmer-text' : ''}`}>
                      {liveThinking}
                    </div>
                  </details>
                )}
                {running && (mode === 'research' || mode === 'agent') && !liveAnswer && !liveSteps.some((s) => s.kind === 'tool') && (
                  <div className="flex items-center gap-2 text-[13px] text-slate-400">
                    <Loader2 size={12} className="animate-spin" />
                    <span>{statusMsg || 'working'}</span>
                  </div>
                )}
                {statusMsg && !liveAnswer && liveSteps.length === 0 && (
                  <div className="flex items-center gap-2 text-[13px] text-slate-400" aria-live="polite">
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
                  onOpenArtifactByName={onOpenArtifactByName}
                />
                {!liveAnswer && !statusMsg && liveSteps.length === 0 && running && <ThinkingDots />}
              </div>
            </>
          )}

          {/* Floating jump-to-bottom (audit §8-18): visible while reading
              history; hidden at the bottom. */}
          <AnimatePresence>
            {!atBottom && (
              <motion.button
                type="button"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ duration: 0.15 }}
                onClick={jumpToBottom}
                title="Jump to latest"
                aria-label="Jump to latest"
                className="fixed bottom-32 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full glass border border-white/10 text-[12px] text-slate-300 hover:text-slate-100 shadow-panel"
              >
                <ArrowDown size={12} /> Latest
              </motion.button>
            )}
          </AnimatePresence>

          <div ref={endRef} />
        </div>
      )}
    </div>
  )
}
