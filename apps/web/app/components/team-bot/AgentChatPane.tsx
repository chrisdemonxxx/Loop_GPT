'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Bot, Clock, Loader2, Monitor, Square, GraduationCap } from 'lucide-react'
import { BOT_STATUS_LABEL, type BotQuota, type BotSkillRef, type BotTask } from '../../lib/bot'

/**
 * Task thread for a named bot. A message becomes a one-shot task. The thread
 * shows each instruction and the run's outcome. The greeting uses the bot's
 * name when the thread's messages are not loaded here.
 */
export function AgentChatPane({
  tasks,
  sending,
  sendError,
  quota,
  suggestedSkills,
  attachedSkill,
  botName = '',
  requiresComputer = true,
  onSend,
  onWatch,
  onTrace,
  onCancel,
  onDismissSuggestions,
  onAttachSkill,
}: {
  tasks: BotTask[] | null
  sending: boolean
  sendError?: string
  quota?: BotQuota | null
  suggestedSkills?: BotSkillRef[]
  attachedSkill?: BotSkillRef | null
  /** Empty when the roster has not resolved a bot. */
  botName?: string
  /** When false, a missing computer quota does not block the composer. */
  requiresComputer?: boolean
  onSend: (text: string) => Promise<void>
  /** Active run → open that run's computer. */
  onWatch: (taskId: string) => void
  /** Finished run → open the run's written trace. */
  onTrace: (taskId: string) => void
  onCancel: (taskId: string) => void
  onDismissSuggestions?: () => void
  onAttachSkill?: (skill: BotSkillRef | null) => void
}) {
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  // Thread = chronological (oldest → newest) so the latest sits at the bottom.
  const thread = useMemo(
    () => [...(tasks || [])].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [tasks],
  )

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [thread.length, thread[thread.length - 1]?.status, thread[thread.length - 1]?.result])

  const name = botName.trim()
  const computerBlocked = requiresComputer && !!quota && (!quota.computerAllowed || !quota.computerConfigured)
  const composerHint = !requiresComputer || !quota
    ? null
    : !quota.computerConfigured
      ? 'Computer provider is not configured on this deployment.'
      : !quota.computerAllowed
        ? 'Dedicated computer requires a plan with computer minutes.'
        : null

  const send = async () => {
    const text = draft.trim()
    if (!text || sending || computerBlocked) return
    setDraft('')
    try { await onSend(text) } catch { setDraft(text) }
  }

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* Thread */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-5 py-5"
        onScroll={() => {
          const el = scrollRef.current
          if (!el) return
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="max-w-2xl mx-auto space-y-4">
          <div className="flex items-start gap-3">
            <Avatar />
            <div className="rounded-2xl rounded-tl-md bg-[var(--bg-hover)] px-4 py-3 text-ui-base leading-relaxed text-[var(--ink-primary)]">
              {name ? `Hi — I'm ${name}. Tell me what to take off your plate.` : 'Tell me what to take off your plate.'}
            </div>
          </div>

          {!!suggestedSkills?.length && (
            <div className="rounded-xl border border-[var(--accent-soft-border)] bg-[var(--accent-soft)] px-3 py-2 text-ui-xs text-[var(--accent-text)]">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-2xs uppercase tracking-wider opacity-80">Suggested skills</span>
                {onDismissSuggestions && (
                  <button type="button" onClick={onDismissSuggestions} className="text-2xs opacity-70 hover:opacity-100">Dismiss</button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {suggestedSkills.map((skill) => (
                  <button
                    key={skill.id}
                    type="button"
                    title={skill.description}
                    aria-pressed={attachedSkill?.id === skill.id}
                    onClick={() => onAttachSkill?.(attachedSkill?.id === skill.id ? null : skill)}
                    className={`rounded-lg bg-[var(--bg-raised)] px-2 py-1 border border-[var(--accent-soft-border)] ${attachedSkill?.id === skill.id ? 'ring-1 ring-[var(--accent-fill)]' : ''}`}
                  >
                    {skill.name}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-2xs opacity-80">Attach a skill, then send. The next message runs with it.</p>
            </div>
          )}

          {thread.map((task) => (
            <Exchange key={task.id} task={task} onWatch={onWatch} onTrace={onTrace} onCancel={onCancel} />
          ))}

          {sending && (
            <div className="flex items-start gap-3">
              <Avatar />
              <div className="flex items-center gap-2 rounded-2xl rounded-tl-md bg-[var(--bg-hover)] px-4 py-3 text-ui-sm text-[var(--ink-secondary)]">
                <Loader2 size={13} className="animate-spin" /> On it…
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Composer — every instruction to the bot goes through here */}
      <div className="shrink-0 border-t border-[var(--border-subtle)] px-5 py-3.5">
        <div className="max-w-2xl mx-auto space-y-2">
          {(sendError || composerHint) && (
            <p className="text-ui-xs text-[var(--danger)]" role="alert">{sendError || composerHint}</p>
          )}
          {attachedSkill && (
            <p className="flex items-center gap-2 text-ui-xs text-[var(--accent-text)]">
              Next message uses {attachedSkill.name}.
              <button type="button" onClick={() => onAttachSkill?.(null)} className="text-[var(--ink-muted)] hover:underline">Clear</button>
            </p>
          )}
          <div className={`flex items-end gap-2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] px-3.5 py-2.5 focus-within:border-[var(--accent)] transition ${computerBlocked ? 'opacity-60' : ''}`}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }}
              rows={1}
              placeholder={computerBlocked ? 'Computer unavailable' : (name ? `Message ${name}` : 'Message')}
              aria-label={name ? `Message ${name}` : 'Message'}
              disabled={computerBlocked}
              className="flex-1 bg-transparent resize-none text-ui-base text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)] focus:outline-none max-h-32 disabled:cursor-not-allowed"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={!draft.trim() || sending || computerBlocked}
              aria-label="Send"
              className="shrink-0 w-8 h-8 rounded-xl flex items-center justify-center text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={15} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Avatar() {
  return (
    <div className="w-7 h-7 rounded-[10px] bg-[var(--accent-soft)] border border-[var(--accent-soft-border)] flex items-center justify-center shrink-0 mt-0.5">
      <Bot size={14} className="text-[var(--accent-text)]" />
    </div>
  )
}

/** One instruction exchange: user bubble (the goal) + bot bubble (the run). */
function Exchange({
  task, onWatch, onTrace, onCancel,
}: {
  task: BotTask
  onWatch: (taskId: string) => void
  onTrace: (taskId: string) => void
  onCancel: (taskId: string) => void
}) {
  const active = task.status === 'queued' || task.status === 'processing'
  const teach = task.kind === 'teach'
  const routine = task.kind === 'scheduled'
  return (
    <div className="space-y-2.5">
      {/* User instruction */}
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-tr-md bg-[var(--bg-hover-strong)] px-4 py-2.5 text-ui-base text-[var(--ink-primary)] whitespace-pre-wrap">
          {teach && (
            <span className="mr-1.5 inline-flex items-center gap-1 text-2xs text-[var(--danger)] align-middle">
              <GraduationCap size={11} /> teach
            </span>
          )}
          {routine && (
            <span className="mr-1.5 inline-flex items-center gap-1 text-2xs text-[var(--accent-text)] align-middle">
              <Clock size={11} /> routine
            </span>
          )}
          {task.goal}
        </div>
      </div>

      {/* Bot reply: the run state, in words */}
      <div className="flex items-start gap-3">
        <Avatar />
        <div className="max-w-[85%] rounded-2xl rounded-tl-md bg-[var(--bg-hover)] px-4 py-3">
          <div className="flex items-center gap-2 text-ui-sm text-[var(--ink-primary)]">
            {active && <Loader2 size={12} className="animate-spin text-[var(--accent-text)]" />}
            <span>{replyFor(task)}</span>
          </div>
          {task.status === 'succeeded' && task.result && (
            <p className="mt-2 whitespace-pre-wrap text-ui-sm text-[var(--ink-secondary)] leading-relaxed">{task.result}</p>
          )}
          <div className="mt-2 flex items-center gap-2">
            {active ? (
              <button
                type="button"
                onClick={() => onWatch(task.id)}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-ui-xs bg-[var(--bg-hover)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover-strong)] transition"
              >
                <Monitor size={11} /> Watch
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onTrace(task.id)}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-ui-xs bg-[var(--bg-hover)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover-strong)] transition"
              >
                <Monitor size={11} /> Trace
              </button>
            )}
            {active && (
              <button
                type="button"
                onClick={() => onCancel(task.id)}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-ui-xs text-[var(--ink-muted)] hover:text-[var(--danger)] transition"
              >
                <Square size={10} /> Stop
              </button>
            )}
            <span className="ml-auto text-2xs text-[var(--ink-muted)] tabular-nums">
              {new Date(task.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

function replyFor(task: BotTask): string {
  switch (task.status) {
    case 'queued':
      return 'Queued — picking it up now.'
    case 'processing':
      return task.kind === 'teach'
        ? 'Recording your demonstration on my computer.'
        : 'Working on it — watch me on the Computer tab.'
    case 'succeeded':
      return task.result ? 'Done.' : 'Done. Open the trace for the full run.'
    case 'dead_letter':
      return `It failed${task.lastErrorCode ? ` — ${task.lastErrorCode.replace(/^BOT_/, '').replace(/_/g, ' ').toLowerCase()}` : ''}. Say the word and I'll retry.`
    case 'cancelled':
      return 'Stopped before it finished.'
    default:
      return BOT_STATUS_LABEL[task.status]
  }
}
