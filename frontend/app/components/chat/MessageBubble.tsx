'use client'

import { useState } from 'react'
import { Copy, Check, Edit2, RotateCcw, Sparkles, Volume2, Pause, Square, Brain } from 'lucide-react'
import { motion } from 'framer-motion'
import { type ArtifactRef } from '../../lib/stream'
import type { Message, StoredStep } from './types'
import Markdown from './Markdown'
import { useAttachmentUrl } from './artifactUrl'
import { ArtifactCard } from './ArtifactCard'
import TurnActivity from './TurnActivity'
import { useSpeech } from '../../lib/voice'

/** One chat row: user bubble (right, editable) or assistant turn (markdown,
 * artifacts, sources, enhanced-prompt diff, read-aloud, retry). Artifact
 * cards open the right-hand artifacts panel (page-owned focus state). */
export function MessageBubble({
  message, onEdit, onRetry, onOpenArtifact,
}: {
  message: Message
  onEdit?: () => void
  onRetry?: () => void
  onOpenArtifact?: (artifact: ArtifactRef) => void
}) {
  const [copied, setCopied] = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)
  const artifacts: ArtifactRef[] = message.metadata?.artifacts || []
  const storedSteps: StoredStep[] = Array.isArray(message.metadata?.steps) ? message.metadata.steps : []
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

      {/* Inline agent activity (audit P1): the persisted tool timeline for
          this turn as a collapsed one-line summary ("Ran N steps"). */}
      {storedSteps.length > 0 && (
        <TurnActivity storedSteps={storedSteps} onRetry={onRetry} />
      )}

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
          {artifacts.map((a) => <ArtifactCard key={a.id} a={a} onOpen={onOpenArtifact ? () => onOpenArtifact(a) : undefined} />)}
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

export function ActionBtn({ onClick, title, ariaLabel, icon }: { onClick: () => void; title: string; ariaLabel?: string; icon: React.ReactNode }) {
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
