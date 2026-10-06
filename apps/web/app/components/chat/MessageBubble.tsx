'use client'

import { useState } from 'react'
import { Copy, Check, ChevronLeft, ChevronRight, Edit2, RotateCcw, Sparkles, Volume2, Pause, Square, Brain, ThumbsUp, ThumbsDown, Loader2 } from 'lucide-react'
import { motion } from 'framer-motion'
import { API_URL, authHeaders } from '../../lib/api'
import { type ArtifactRef } from '../../lib/stream'
import { type BranchVersionInfo } from '../../lib/branch'
import type { Message, StoredStep } from './types'
import Markdown from './Markdown'
import { useAttachmentUrl } from './artifactUrl'
import { ArtifactCard } from './ArtifactCard'
import TurnActivity from './TurnActivity'
import { useSpeech } from '../../lib/voice'
import { useToast } from '../../lib/toast'

/** Long user messages truncate with an inline expander (audit §8-20). */
const USER_TRUNCATE = 420

/** <2/3> version arrows (audit §8-22): retries and edits are sibling
 * versions of a turn; the arrows flip the transcript between them. */
function VersionArrows({ info, onSelect }: { info: BranchVersionInfo; onSelect?: (messageId: string) => void }) {
  const pick = (row?: Message) => row && onSelect?.(row.id)
  return (
    <span className="inline-flex items-center gap-0.5" data-testid="version-arrows">
      <ActionBtn
        onClick={() => pick(info.prev)}
        title="Previous version"
        ariaLabel={`Show previous version (${info.index - 1} of ${info.count})`}
        icon={<ChevronLeft size={14} />}
      />
      <span className="text-[11px] text-slate-400 tabular-nums px-0.5 select-none" aria-label={`Version ${info.index} of ${info.count}`}>
        {info.index}/{info.count}
      </span>
      <ActionBtn
        onClick={() => pick(info.next)}
        title="Next version"
        ariaLabel={`Show next version (${info.index + 1} of ${info.count})`}
        icon={<ChevronRight size={14} />}
      />
    </span>
  )
}

/** One chat row: user bubble (right, editable, truncated when long) or
 * assistant turn (markdown, artifacts, sources, read-aloud, retry, and
 * thumbs feedback wired to POST /api/telemetry/feedback — audit §8-21).
 * Artifact cards open the right-hand artifacts panel. */
export function MessageBubble({
  message, conversationId, onEdit, onRetry, onOpenArtifact, onOpenArtifactByName, version, onSelectVersion,
}: {
  message: Message
  conversationId?: string | null
  onEdit?: () => void
  onRetry?: () => void
  onOpenArtifact?: (artifact: ArtifactRef) => void
  /** §8-28: per-step "View in panel" links resolve artifact names here. */
  onOpenArtifactByName?: (name: string) => void
  /** §8-22: sibling-version info when this row has alternates. */
  version?: BranchVersionInfo
  /** §8-22: flip to a sibling version row. */
  onSelectVersion?: (messageId: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [rating, setRating] = useState<'up' | 'down' | null>(null)
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)
  const toast = useToast()
  const artifacts: ArtifactRef[] = message.metadata?.artifacts || []
  const storedSteps: StoredStep[] = Array.isArray(message.metadata?.steps) ? message.metadata.steps : []
  const sources = message.metadata?.sources as { index: number; title: string; url: string }[] | undefined
  const promptMeta = message.metadata?.prompt as { raw: string; enhanced: string; optimized: boolean } | undefined
  /** Intrinsic dimensions persisted by the vision pipeline (audit P4):
   *  explicit width/height eliminates layout shift before the blob loads. */
  const imgW = typeof message.metadata?.imageWidth === 'number' ? message.metadata.imageWidth : undefined
  const imgH = typeof message.metadata?.imageHeight === 'number' ? message.metadata.imageHeight : undefined
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
              width={imgW}
              height={imgH}
              loading="lazy"
              decoding="async"
              className="max-w-[280px] max-h-64 rounded-xl border border-white/10 mb-2.5"
            />
          )}
          {message.content && (
            <div className="whitespace-pre-wrap text-slate-100 text-[15px] leading-relaxed">
              {expanded || (message.content.length <= USER_TRUNCATE)
                ? message.content
                : <>
                    {message.content.slice(0, USER_TRUNCATE).replace(/\s+\S*$/, '')}…
                    <button
                      type="button"
                      onClick={() => setExpanded(true)}
                      className="ml-1 text-[12.5px] text-[#e79d7f] hover:underline"
                    >
                      Show more
                    </button>
                  </>}
              {expanded && message.content.length > USER_TRUNCATE && (
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  className="ml-1 text-[12.5px] text-slate-400 hover:underline"
                >
                  Show less
                </button>
              )}
            </div>
          )}
        </div>
        {onEdit && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity pr-1">
            {version && <VersionArrows info={version} onSelect={onSelectVersion} />}
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
            <Brain size={12} className="text-slate-400" /> Thoughts
          </summary>
          <div className="px-3.5 pb-3 text-[12.5px] leading-relaxed text-slate-400 whitespace-pre-wrap max-h-64 overflow-y-auto">
            {String(message.metadata.reasoning)}
          </div>
        </details>
      )}
      {message.content && <Markdown content={message.content} />}

      {/* Inline agent activity (audit P1): the persisted tool timeline for
          this turn as a collapsed one-line summary ("Ran N steps"). */}
      {storedSteps.length > 0 && (
        <TurnActivity storedSteps={storedSteps} onRetry={onRetry} onOpenArtifactByName={onOpenArtifactByName} />
      )}

      {promptMeta?.optimized && (
        <div className="text-[12px]">
          <button
            type="button"
            onClick={() => setShowPrompt((v) => !v)}
            className="inline-flex items-center gap-1 text-slate-400 hover:text-slate-300 transition"
            aria-expanded={showPrompt}
          >
            <Sparkles size={11} /> {showPrompt ? 'Hide' : 'View'} enhanced prompt
          </button>
          {showPrompt && (
            <div className="mt-1.5 rounded-xl border border-white/[0.07] bg-white/[0.03] p-3 space-y-2">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-slate-400">Original</div>
                <div className="text-slate-400 whitespace-pre-wrap">{promptMeta.raw}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-slate-400">Enhanced (sent to the model)</div>
                <div className="text-slate-200 whitespace-pre-wrap">{promptMeta.enhanced}</div>
              </div>
            </div>
          )}
        </div>
      )}

      {artifacts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {artifacts.map((a) => <ArtifactCard key={a.id} a={a} onOpen={onOpenArtifact ? () => onOpenArtifact(a) : undefined} />)}
        </div>
      )}

      {sources && sources.length > 0 && (
        <div className="text-[12px] text-slate-400 space-y-1">
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
        {version && <VersionArrows info={version} onSelect={onSelectVersion} />}
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
        {/* Feedback (audit §8-21): wired to POST /api/telemetry/feedback —
            previously thumbs were local-state-only and never sent. */}
        <ActionBtn
          onClick={() => { setRating('up'); setFeedbackOpen(true) }}
          title="Good response"
          ariaLabel="Rate this response as good"
          icon={<ThumbsUp size={14} />}
        />
        <ActionBtn
          onClick={() => { setRating('down'); setFeedbackOpen(true) }}
          title="Poor response"
          ariaLabel="Rate this response as poor"
          icon={<ThumbsDown size={14} />}
        />
      </div>

      {/* Feedback modal (rating + optional comment → telemetry). */}
      {feedbackOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setFeedbackOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Send feedback"
        >
          <div
            className="glass-strong rounded-2xl border border-white/10 w-full max-w-sm p-4 space-y-3 shadow-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[14px] font-medium text-slate-100">Send feedback</div>
            <div className="flex gap-2">
              {(['up', 'down'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRating(r)}
                  aria-pressed={rating === r}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border text-[13px] transition ${
                    rating === r
                      ? 'border-[#c96442]/50 bg-[#c96442]/[0.08] text-[#e79d7f]'
                      : 'border-white/[0.08] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {r === 'up' ? <ThumbsUp size={14} /> : <ThumbsDown size={14} />}
                  {r === 'up' ? 'Good' : 'Needs work'}
                </button>
              ))}
            </div>
            <textarea
              rows={3}
              placeholder="Optional: what worked, what didn't?"
              onChange={(e) => setComment(e.target.value)}
              className="w-full rounded-xl bg-white/[0.04] border border-white/[0.08] px-3 py-2 text-[13px] text-slate-200 placeholder-slate-500 focus:outline-none focus:border-white/15 resize-none"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={async () => {
                  if (!rating) return
                  setSending(true)
                  try {
                    const res = await fetch(`${API_URL}/api/telemetry/feedback`, {
                      method: 'POST',
                      headers: authHeaders(),
                      body: JSON.stringify({ conversationId: conversationId || null, messageId: message.id, rating, comment: comment || undefined }),
                    })
                    if (!res.ok) throw new Error('send')
                    toast.push('success', 'Thanks — feedback recorded')
                    setFeedbackOpen(false)
                  } catch {
                    toast.push('error', 'Could not send feedback — try again')
                  } finally {
                    setSending(false)
                  }
                }}
                disabled={!rating || sending}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium text-white bg-[#c96442] hover:bg-[#b5593a] disabled:opacity-40 transition"
              >
                {sending && <Loader2 size={13} className="animate-spin" />} Submit feedback
              </button>
              <button
                type="button"
                onClick={() => setFeedbackOpen(false)}
                className="px-3 py-2 rounded-xl text-[13px] text-slate-400 hover:text-slate-200 border border-white/[0.08] transition"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  )
}

export function ActionBtn({ onClick, title, ariaLabel, icon }: { onClick: () => void; title: string; ariaLabel?: string; icon: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={ariaLabel || title}
      className="p-1.5 rounded-md text-slate-400 hover:text-slate-300 hover:bg-white/[0.05] transition"
    >
      {icon}
    </button>
  )
}
