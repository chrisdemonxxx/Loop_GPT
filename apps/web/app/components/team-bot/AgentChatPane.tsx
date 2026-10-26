'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Bot, Clock, Loader2, Monitor, Square, GraduationCap } from 'lucide-react'
import { BOT_STATUS_LABEL, type BotQuota, type BotSkillRef, type BotTask } from '../../lib/bot'
import { computerUnavailableMessage, taskInProgress } from '../../agents/botTask'
import { BrowserRunSwitch } from '../browser/BrowserRunSwitch'
import { Markdown } from '../chat/Markdown'
import { PdfView, SheetView, useSheetRows } from '../chat/ArtifactViewers'

/**
 * Task thread for a named bot. A message becomes a one-shot task. The thread
 * shows each instruction and the run's outcome. The greeting uses the bot's
 * name when the thread's messages are not loaded here.
 */
function BotArtifact({ artifact }: { artifact: { id: string; kind: string; name: string; url?: string } }) {
  const sheet = /\.(xlsx|csv)$/i.test(artifact.name)
  const rows = useSheetRows(sheet ? artifact.url : undefined)
  if (/\.docx$/i.test(artifact.name)) {
    return (
      <a href={artifact.url || '#'} download={artifact.name} className="mt-2 inline-flex text-ui-xs text-[var(--accent-text)] underline">
        Download {artifact.name}
      </a>
    )
  }
  if (/\.pdf$/i.test(artifact.name) && artifact.url) {
    return <PdfView a={artifact} open={{ url: artifact.url, error: false, retry: () => undefined }} />
  }
  if (sheet && artifact.url) return <SheetView rows={rows.rows} error={rows.error} onRetry={rows.retry} />
  return <span className="mt-2 block text-ui-xs text-[var(--ink-secondary)]">{artifact.name}</span>
}

export function AgentChatPane({
  tasks,
  sending,
  sendError,
  quota,
  suggestedSkills,
  attachedSkill,
  botName = '',
  requiresComputer = true,
  threadsReady = true,
  onSend,
  onWatch,
  onTrace,
  onCancel,
  onDismissSuggestions,
  onAttachSkill,
  onReset,
  approvalMode = 'ask',
  pendingApproval = null,
  onApprove,
  onApprovalMode,
  browserEnabled = false,
  browserDeviceId = '',
  onBrowserEnabled,
  onBrowserDevice,
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
  /** False while the thread list is still loading. Send stays disabled. */
  threadsReady?: boolean
  onSend: (text: string, attachments?: Array<{ name: string; path: string }>) => Promise<void>
  /** Active run → open that run's computer. */
  onWatch: (taskId: string) => void
  /** Finished run → open the run's written trace. */
  onTrace: (taskId: string) => void
  onCancel: (taskId: string) => void
  onDismissSuggestions?: () => void
  onAttachSkill?: (skill: BotSkillRef | null) => void
  onReset?: () => void
  approvalMode?: 'ask' | 'safe' | 'accept'
  pendingApproval?: { id: string; name: string; category: 'computer' | 'terminal' | 'tool'; args?: Record<string, unknown> } | null
  onApprove?: (approvalId: string, approved: boolean) => void
  onApprovalMode?: (mode: 'ask' | 'safe' | 'accept') => void
  browserEnabled?: boolean
  browserDeviceId?: string
  onBrowserEnabled?: (next: boolean) => void
  onBrowserDevice?: (id: string) => void
}) {
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Array<{ name: string; path: string }>>([])
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
  const composerHint = requiresComputer ? computerUnavailableMessage(quota) : null
  const sendLocked = !threadsReady

  const send = async () => {
    const text = draft.trim()
    if ((!text && attachments.length === 0) || sending || sendLocked) return
    setDraft('')
    const files = attachments
    setAttachments([])
    try {
      if (files.length) await onSend(text, files)
      else await onSend(text)
    } catch { setDraft(text); setAttachments(files) }
  }

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex items-center justify-between gap-2 px-5 pt-3">
        <BrowserRunSwitch
          enabled={browserEnabled}
          deviceId={browserDeviceId}
          onEnabled={(next) => onBrowserEnabled?.(next)}
          onDevice={(id) => onBrowserDevice?.(id)}
          compact
        />
        <div className="flex items-center gap-2">
        {onApprovalMode && (
          <label className="text-2xs text-[var(--ink-muted)]">
            Approvals
            <select
              aria-label="Approval mode"
              value={approvalMode}
              onChange={(e) => onApprovalMode(e.target.value as 'ask' | 'safe' | 'accept')}
              className="ml-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1 text-ui-xs"
            >
              <option value="ask">Ask</option>
              <option value="safe">Auto</option>
              <option value="accept">Accept all</option>
            </select>
          </label>
        )}
        {onReset && (
          <button type="button" onClick={onReset} className="text-ui-xs text-[var(--ink-muted)] hover:text-[var(--ink-primary)]">
            Reset conversation
          </button>
        )}
        </div>
      </div>
      {approvalMode !== 'accept' && pendingApproval && (
        <div className="mx-5 mt-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] px-3 py-2 text-ui-xs">
          <p className="text-[var(--ink-secondary)]">Allow {pendingApproval.name.replace(/_/g, ' ')}? This is a {pendingApproval.category} action.</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => onApprove?.(pendingApproval.id, true)} className="rounded-lg bg-[var(--accent-fill)] px-2.5 py-1 text-white">Approve</button>
            <button type="button" onClick={() => onApprove?.(pendingApproval.id, false)} className="rounded-lg px-2.5 py-1 text-[var(--ink-secondary)]">Deny</button>
          </div>
        </div>
      )}
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
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {attachments.map((file) => (
                <span key={file.name} className="rounded-lg bg-[var(--bg-hover)] px-2 py-1 text-2xs text-[var(--ink-secondary)]">{file.name}</span>
              ))}
            </div>
          )}
          <div
            className={`flex items-end gap-2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] px-3.5 py-2.5 focus-within:border-[var(--accent)] transition ${sendLocked ? 'opacity-60' : ''}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const files = Array.from(e.dataTransfer?.files || [])
              if (!files.length) return
              setAttachments((cur) => [...cur, ...files.map((file) => ({ name: file.name, path: `/workspace/inbox/${file.name}` }))])
            }}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }}
              rows={1}
              placeholder={!threadsReady ? 'Loading chats…' : (name ? `Message ${name}` : 'Message')}
              aria-label={name ? `Message ${name}` : 'Message'}
              disabled={sendLocked}
              className="flex-1 bg-transparent resize-none text-ui-base text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)] focus:outline-none max-h-32 disabled:cursor-not-allowed"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={(!draft.trim() && attachments.length === 0) || sending || sendLocked}
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
  const active = taskInProgress(task)
  const teach = task.kind === 'teach'
  const routine = task.kind === 'scheduled'
  const waitingRoutine = routine && task.status === 'queued' && !active
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
          {(task.status === 'succeeded' || waitingRoutine) && task.result && (
            <div className="mt-2 text-ui-sm text-[var(--ink-secondary)] leading-relaxed">
              <Markdown content={task.result} />
            </div>
          )}
          {task.artifacts?.map((artifact) => (
            <BotArtifact key={artifact.id} artifact={artifact} />
          ))}
          <div className="mt-2 flex items-center gap-2">
            {active && (
              <button
                type="button"
                onClick={() => onWatch(task.id)}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-ui-xs bg-[var(--bg-hover)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover-strong)] transition"
              >
                <Monitor size={11} /> Watch
              </button>
            )}
            <button
              type="button"
              onClick={() => onTrace(task.id)}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-ui-xs bg-[var(--bg-hover)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover-strong)] transition"
            >
              <Monitor size={11} /> Trace
            </button>
            {(active || waitingRoutine) && (
              <button
                type="button"
                onClick={() => onCancel(task.id)}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-ui-xs text-[var(--ink-muted)] hover:text-[var(--danger)] transition"
              >
                <Square size={10} /> {waitingRoutine ? 'Cancel schedule' : 'Stop'}
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
  if (task.kind === 'scheduled' && task.status === 'queued' && !taskInProgress(task)) {
    const when = task.nextAttemptAt ? new Date(task.nextAttemptAt).toLocaleString() : ''
    return when ? `Next run ${when}.` : 'Waiting for the next run.'
  }
  switch (task.status) {
    case 'queued':
      return 'Queued — picking it up now.'
    case 'processing':
      return task.kind === 'teach'
        ? 'Recording your demonstration on my computer.'
        : 'Working on it — watch me on the Computer tab.'
    case 'succeeded':
      return task.result ? 'Done.' : 'Done. Open the trace for the full run.'
    case 'dead_letter': {
      const why = task.lastErrorCode
        ? ` — ${task.lastErrorCode.replace(/^BOT_/, '').replace(/_/g, ' ').toLowerCase()}`
        : ''
      return `It failed${why}. This run will not be retried.`
    }
    case 'cancelled':
      return 'Stopped before it finished.'
    default:
      return BOT_STATUS_LABEL[task.status]
  }
}
