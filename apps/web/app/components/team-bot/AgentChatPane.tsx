'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Bot, Loader2, Monitor, Square, GraduationCap } from 'lucide-react'
import { BOT_STATUS_LABEL, type BotTask } from '../../lib/bot'

/**
 * The Grok Bot chat pane: the ONLY way to instruct the agent. A message sent
 * here becomes a one-shot task on its computer; the thread renders each
 * instruction as a user bubble and the run's live state / outcome as the
 * bot's reply — same shape as Grok's "Message Helm" thread.
 */
export function AgentChatPane({
  tasks,
  sending,
  onSend,
  onWatch,
  onCancel,
}: {
  tasks: BotTask[] | null
  sending: boolean
  onSend: (text: string) => Promise<void>
  onWatch: (taskId: string) => void
  onCancel: (taskId: string) => void
}) {
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // Thread = tasks oldest → newest (teach sessions get their own marker).
  const thread = useMemo(
    () => [...(tasks || [])].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [tasks],
  )

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread.length, thread[thread.length - 1]?.status])

  const send = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setDraft('')
    try { await onSend(text) } catch { setDraft(text) }
  }

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* Thread */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-5 py-5">
        <div className="max-w-2xl mx-auto space-y-4">
          <div className="flex items-start gap-3">
            <Avatar />
            <div className="rounded-2xl rounded-tl-md bg-white/[0.05] px-4 py-3 text-[13.5px] leading-relaxed text-slate-200">
              Hi — I&apos;m Loop Bot. Tell me what to take off your plate and I&apos;ll run it on my computer.
              You can watch me work from the Computer tab, and teach me new skills there too.
            </div>
          </div>

          {thread.map((task) => (
            <Exchange key={task.id} task={task} onWatch={onWatch} onCancel={onCancel} />
          ))}

          {sending && (
            <div className="flex items-start gap-3">
              <Avatar />
              <div className="flex items-center gap-2 rounded-2xl rounded-tl-md bg-white/[0.05] px-4 py-3 text-[13px] text-slate-400">
                <Loader2 size={13} className="animate-spin" /> On it…
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Composer — every instruction to the bot goes through here */}
      <div className="shrink-0 border-t border-white/[0.06] px-5 py-3.5">
        <div className="max-w-2xl mx-auto flex items-end gap-2 rounded-2xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-2.5 focus-within:border-[var(--accent)] transition">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }}
            rows={1}
            placeholder="Message Loop Bot"
            aria-label="Message Loop Bot"
            className="flex-1 bg-transparent resize-none text-[13.5px] text-slate-200 placeholder:text-slate-600 focus:outline-none max-h-32"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!draft.trim() || sending}
            aria-label="Send"
            className="shrink-0 w-8 h-8 rounded-xl flex items-center justify-center text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {sending ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={15} />}
          </button>
        </div>
      </div>
    </div>
  )
}

function Avatar() {
  return (
    <div className="w-7 h-7 rounded-[10px] bg-[#c96442]/15 border border-[#c96442]/25 flex items-center justify-center shrink-0 mt-0.5">
      <Bot size={14} className="text-[#e79d7f]" />
    </div>
  )
}

/** One instruction exchange: user bubble (the goal) + bot bubble (the run). */
function Exchange({
  task, onWatch, onCancel,
}: {
  task: BotTask
  onWatch: (taskId: string) => void
  onCancel: (taskId: string) => void
}) {
  const active = task.status === 'queued' || task.status === 'processing'
  const teach = task.kind === 'teach'
  return (
    <div className="space-y-2.5">
      {/* User instruction */}
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-tr-md bg-white/[0.08] px-4 py-2.5 text-[13.5px] text-slate-100 whitespace-pre-wrap">
          {teach && (
            <span className="mr-1.5 inline-flex items-center gap-1 text-[11px] text-rose-300 align-middle">
              <GraduationCap size={11} /> teach
            </span>
          )}
          {task.goal}
        </div>
      </div>

      {/* Bot reply: the run state, in words */}
      <div className="flex items-start gap-3">
        <Avatar />
        <div className="max-w-[85%] rounded-2xl rounded-tl-md bg-white/[0.05] px-4 py-3">
          <div className="flex items-center gap-2 text-[13px] text-slate-200">
            {active && <Loader2 size={12} className="animate-spin text-[var(--accent-text)]" />}
            <span>{replyFor(task)}</span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => onWatch(task.id)}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11.5px] bg-white/[0.05] text-slate-400 hover:text-slate-200 hover:bg-white/[0.09] transition"
            >
              <Monitor size={11} /> {active ? 'Watch' : 'Trace'}
            </button>
            {active && (
              <button
                type="button"
                onClick={() => onCancel(task.id)}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11.5px] text-slate-500 hover:text-rose-300 transition"
              >
                <Square size={10} /> Stop
              </button>
            )}
            <span className="ml-auto text-[10.5px] text-slate-600 tabular-nums">
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
      return 'Done. Open the trace for the full run.'
    case 'dead_letter':
      return `It failed${task.lastErrorCode ? ` — ${task.lastErrorCode.replace(/^BOT_/, '').replace(/_/g, ' ').toLowerCase()}` : ''}. Say the word and I'll retry.`
    case 'cancelled':
      return 'Stopped before it finished.'
    default:
      return BOT_STATUS_LABEL[task.status]
  }
}
