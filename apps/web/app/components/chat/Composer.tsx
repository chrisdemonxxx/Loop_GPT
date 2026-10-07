'use client'

import { useEffect, useRef, useState } from 'react'
import { Mic, UploadCloud, Plug, AudioLines } from 'lucide-react'
import type { AgentMode } from '../../lib/api'
import { SLASH_SECTIONS, filterCommands } from '../../lib/commands'
import { applyMention, mentionDraft } from '../../lib/namedBots'
import { useI18n } from '../../lib/i18n'
import { useDictation } from '../../lib/voice'
import type { PendingAttachment } from '../../chat/hooks'
import { SlashPalette, type ToggleState } from './composer/SlashPalette'
import { PlusMenu, AttachmentChips, DictationBar } from './composer/PlusMenu'
import { RunSettings } from './composer/RunSettings'
import type { EffortValue } from './composer/EffortSelector'
import { SendButton } from './composer/SendButton'
import { modKey } from '../../lib/platformKey'

export type RunMode = 'auto' | 'plan' | 'step' | 'accept'

interface ComposerProps {
  input: string
  /** Attachments (upload at attach-time, audit P2.7). */
  attachments: PendingAttachment[]
  onRemoveAttachment: (id: string) => void
  onRetryAttachment: (id: string) => void
  running: boolean
  runMode: RunMode
  /** Web-search override (§8-25): auto defers to tool selection; on/off are
   *  explicit per-run overrides. */
  webSearch: ToggleState
  onToggleWebSearch: (next: ToggleState) => void
  /** Extended-thinking override (§8-26) — widened to the effort union
   *  (contract §A): auto/low/medium/high/xhigh/off. auto = server default,
   *  off = explicit no-think. Wired against the Brain tri-state above it. */
  thinking: EffortValue
  onToggleThinking: (next: EffortValue) => void
  /** Context meter (§2.5): 0-100 estimated window usage. */
  contextPct?: number
  contextTokens?: number
  incognito?: boolean
  showSlash: boolean
  showPlus: boolean
  onInputChange: (value: string) => void
  onSelectSlashCommand: (cmd: string) => void
  onSend: (e?: React.FormEvent) => void
  onStop: () => void
  onImagesSelected: (files: File[]) => void
  onTogglePlus: () => void
  onClosePlus: () => void
  onRunModeChange: (mode: RunMode) => void
  onOpenConnectors: () => void
  onOpenSettingsTab: (tab: string) => void
  /** Workspace connections (§8-40): recent-use-first chips; clicking pins
   *  one for the next run (its tools join via connectionIds). */
  connections?: Array<{ id: string; name: string; type: string }>
  pinnedConnectionId?: string | null
  onTogglePinConnection?: (id: string) => void
  /** Hands-free voice mode (§8-44): speak answers, re-listen, auto-send. */
  voiceMode?: boolean
  voiceModeSupported?: boolean
  voiceModeListening?: boolean
  onToggleVoiceMode?: () => void
  /** Messages queued behind the active run — drives the SendButton badge. */
  queuedCount?: number
  /** Visible placeholder. Defaults to "Message…". */
  placeholder?: string
  /** Walk the sent-prompt history. Return the text to load, or null to ignore. */
  onPromptHistory?: (dir: -1 | 1) => string | null
  /** Ctrl/Cmd + arrows: previous/next conversation. */
  onCycleConversation?: (dir: -1 | 1) => void
  /** Escape while an edit is loaded and no menu is open. */
  onCancelEdit?: () => void
  /** Ctrl/Cmd+Z while an edit is loaded. Return true when the edit was restored. */
  onEditUndo?: () => boolean
  /** Ctrl/Cmd+Y (or Ctrl/Cmd+Shift+Z) puts the edit back. */
  onEditRedo?: () => boolean
  /** Escape closes the slash menu before the edit. */
  onCloseSlash?: () => void
  /** Members of the open group or project room. Enables the @ menu. */
  mentionMembers?: Array<{ id: string; name: string }>
}

/** Up to four attachments per turn. */
const MAX_IMAGES = 4

/** Chat composer: autogrowing textarea, slash palette (keyboard-navigable),
 * + attach menu, run-mode picker, mic dictation, send/stop, context meter —
 * plus drag-and-drop uploads with a visible drop zone and paste-to-attach
 * (audit P2.7). Attachments upload at attach time with per-chip progress. */
export default function Composer({
  input, attachments, onRemoveAttachment, onRetryAttachment, running, runMode,
  webSearch, onToggleWebSearch, thinking, onToggleThinking,
  contextPct, contextTokens, incognito,
  showSlash, showPlus,
  onInputChange, onSelectSlashCommand, onSend, onStop,
  onImagesSelected,
  onTogglePlus, onClosePlus,
  onRunModeChange, onOpenConnectors, onOpenSettingsTab,
  connections, pinnedConnectionId, onTogglePinConnection,
  voiceMode, voiceModeSupported, voiceModeListening, onToggleVoiceMode,
  queuedCount = 0, placeholder, onPromptHistory, onCycleConversation, onCancelEdit, onCloseSlash, onEditUndo, onEditRedo,
  mentionMembers,
}: ComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const { t } = useI18n()
  const canScreenshot = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia

  // ── Dictation (STT) ───────────────────────────────────────────────────────
  const { supported: micSupported, recording, elapsed, start: startDictation, stop: stopDictation } = useDictation({
    onText: (text, isFinal) => {
      if (isFinal) {
        // Append finalized transcript at the cursor/end.
        onInputChange(`${input}${input && !input.endsWith(' ') ? ' ' : ''}${text.trim()} `)
      } else {
        // Interim: show live, without committing to the stored value.
        setInterim(text)
      }
    },
  })
  const [interim, setInterim] = useState('')
  useEffect(() => { if (!recording) setInterim('') }, [recording])

  const fit = () => {
    const el = textRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }
  useEffect(() => { fit() }, [input])

  const stopAndSend = () => { stopDictation(); requestAnimationFrame(() => onSend()) }

  const captureScreen = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      const track = stream.getVideoTracks()[0]
      const video = document.createElement('video')
      video.srcObject = stream
      await video.play()
      await new Promise((r) => setTimeout(r, 250))
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      canvas.getContext('2d')?.drawImage(video, 0, 0)
      track.stop()
      canvas.toBlob((blob) => {
        if (blob) onImagesSelected([new File([blob], 'screenshot.png', { type: 'image/png' })])
      }, 'image/png')
    } catch { /* user dismissed the picker; no-op */ }
  }

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length) onImagesSelected(files)
    e.target.value = ''
  }

  const slashFilter = filterCommands(input.trim())
  const seenInput = useRef(input)
  if (seenInput.current !== input) {
    seenInput.current = input
    if (mentionDismissed) setMentionDismissed(false)
  }
  const draft = !showSlash && mentionMembers?.length ? mentionDraft(input) : null
  const mentionQuery = (draft?.query || '').toLowerCase()
  const seenQuery = useRef(mentionQuery)
  if (seenQuery.current !== mentionQuery) {
    seenQuery.current = mentionQuery
    if (mentionIndex !== 0) setMentionIndex(0)
  }
  const mentionChoices = (() => {
    if (!draft || mentionDismissed) return [] as Array<{ key: string; name: string; label: string }>
    const seen = new Set<string>()
    const rows: Array<{ key: string; name: string; label: string }> = []
    for (const bot of mentionMembers || []) {
      if (seen.has(bot.id)) continue
      if (mentionQuery && !bot.name.toLowerCase().startsWith(mentionQuery)) continue
      seen.add(bot.id)
      rows.push({ key: bot.id, name: bot.name, label: bot.name })
    }
    if (!mentionQuery || 'all'.startsWith(mentionQuery)) rows.push({ key: 'all', name: 'all', label: 'All' })
    return rows
  })()
  const mentionOpen = mentionChoices.length > 0
  const activeMention = Math.min(mentionIndex, Math.max(0, mentionChoices.length - 1))
  const pickMention = (name: string) => {
    onInputChange(applyMention(input, name))
    requestAnimationFrame(() => textRef.current?.focus())
  }

  // Screenshot is composer-local; everything else delegates to the page.
  const handleCommandClick = (cmd: string) => {
    if (cmd === '/screenshot') { captureScreen(); return }
    onSelectSlashCommand(cmd + ' ')
  }

  const canSend = !!(input.trim() || attachments.some((a) => a.status === 'done'))

  // ── Drag-and-drop uploads (audit P2.7) ────────────────────────────────────
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    if (!e.dataTransfer.types.includes('Files')) return
    dragDepth.current += 1
    setDragActive(true)
  }
  const onDragOver = (e: React.DragEvent) => e.preventDefault()
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragActive(false)
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragActive(false)
    const files = Array.from(e.dataTransfer.files || [])
    if (files.length) onImagesSelected(files)
  }

  // ── Paste-to-attach (audit P2.7): clipboard images land in the composer. ──
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files || []).filter((f) =>
      f.type.startsWith('image/') || /\.(pdf|docx|xlsx|csv|txt|md|markdown)$/i.test(f.name))
    if (files.length) {
      e.preventDefault()
      onImagesSelected(files)
    }
  }

  return (
    <div
      className="relative"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Visible drop zone overlay (audit P2.7: onDrop was entirely absent). */}
      {dragActive && (
        <div className="absolute inset-0 z-30 rounded-2xl border-2 border-dashed border-[#c96442] bg-[#c96442]/10 backdrop-blur-sm flex flex-col items-center justify-center gap-2 pointer-events-none">
          <UploadCloud size={26} className="text-[#e79d7f]" />
          <span className="text-[13px] font-medium text-[#e79d7f]">Drop files to attach</span>
          <span className="text-[11px] text-slate-400">up to 4 · images & documents</span>
        </div>
      )}
      {/* Recording state */}
      {recording && (
        <DictationBar elapsed={elapsed} interim={interim} onCancel={stopDictation} onStopAndSend={stopAndSend} />
      )}

      {/* Hidden file inputs */}
      <input ref={fileInputRef} type="file" accept="image/*,.pdf,.docx,.xlsx,.csv,.txt,.md,.markdown" multiple onChange={handleImageChange} className="hidden" />
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" onChange={handleImageChange} className="hidden" />

      {/* Input form */}
      <form
        onSubmit={onSend}
        className={`rounded-[1.25rem] surface transition overflow-hidden ${recording ? 'border-[#c96442]/40' : 'focus-within:border-white/[0.14] focus-within:bg-[#141418]'}`}
      >
        {showSlash && (
          <SlashPalette
            commands={slashFilter}
            activeIndex={slashIndex}
            onHover={setSlashIndex}
            onSelect={handleCommandClick}
            sections={SLASH_SECTIONS}
            commandsLabel={t('commands')}
          />
        )}
        {mentionOpen && (
          <div className="border-b border-white/[0.06] max-h-64 overflow-y-auto" role="menu" aria-label="Mention a bot">
            {mentionChoices.map((choice, i) => (
              <button
                key={choice.key}
                type="button"
                role="menuitem"
                aria-label={choice.key === 'all' ? 'Mention all bots' : `Mention ${choice.label}`}
                onMouseEnter={() => setMentionIndex(i)}
                onClick={() => pickMention(choice.name)}
                className={`flex w-full items-center gap-1 px-3 py-2 text-left text-[13px] transition ${i === activeMention ? 'bg-white/[0.06] text-slate-100' : 'text-slate-300 hover:bg-white/[0.04]'}`}
              >
                <span className="text-slate-500">@</span>
                {choice.key === 'all' ? 'all' : choice.label}
                {choice.key === 'all' && <span className="ml-2 text-[11px] text-slate-500">everyone in the room</span>}
              </button>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="px-3 pt-2.5">
            <AttachmentChips
              attachments={attachments}
              onRemove={onRemoveAttachment}
              onRetry={onRetryAttachment}
            />
          </div>
        )}
        <textarea
          ref={textRef}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            const el = e.currentTarget
            if (modKey(e) && !e.altKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
              const redo = e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)
              const handled = redo ? onEditRedo?.() : (!e.shiftKey && onEditUndo?.())
              if (handled) { e.preventDefault(); return }
            }
            if (e.key === 'Escape') {
              if (showSlash) { e.preventDefault(); e.stopPropagation(); onCloseSlash?.(); return }
              if (mentionOpen) { e.preventDefault(); e.stopPropagation(); setMentionDismissed(true); return }
              if (showPlus) { e.preventDefault(); e.stopPropagation(); onClosePlus(); return }
              if (onCancelEdit) { e.preventDefault(); onCancelEdit() }
              return
            }
            if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && modKey(e)) {
              e.preventDefault()
              onCycleConversation?.(e.key === 'ArrowUp' ? -1 : 1)
              return
            }
            if (e.key === 'ArrowDown' && mentionOpen) {
              e.preventDefault()
              setMentionIndex((i) => (i + 1) % mentionChoices.length)
            } else if (e.key === 'ArrowUp' && mentionOpen) {
              e.preventDefault()
              setMentionIndex((i) => (i - 1 + mentionChoices.length) % mentionChoices.length)
            } else if (e.key === 'ArrowDown' && showSlash && slashFilter.length > 0) {
              e.preventDefault()
              setSlashIndex((i) => (i + 1) % slashFilter.length)
            } else if (e.key === 'ArrowUp' && showSlash && slashFilter.length > 0) {
              e.preventDefault()
              setSlashIndex((i) => (i - 1 + slashFilter.length) % slashFilter.length)
            } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !showSlash && el.selectionStart === 0 && el.selectionEnd === 0) {
              const next = onPromptHistory?.(e.key === 'ArrowUp' ? -1 : 1)
              if (next != null) { e.preventDefault(); onInputChange(next) }
            } else if (e.key === 'Tab' && mentionOpen) {
              e.preventDefault()
              pickMention(mentionChoices[activeMention].name)
            } else if (e.key === 'Tab' && showSlash && slashFilter.length > 0) {
              e.preventDefault()
              handleCommandClick(slashFilter[slashIndex]?.cmd)
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (showSlash && slashFilter.length > 0 && !modKey(e)) {
                handleCommandClick((slashFilter[slashIndex] || slashFilter[0]).cmd)
              } else if (mentionOpen && !modKey(e)) {
                pickMention(mentionChoices[activeMention].name)
              } else onSend()
            }
          }}
          aria-label={placeholder || 'Message Loop GPT'}
          placeholder={placeholder || 'Message…'}
          rows={1}
          className="w-full bg-transparent px-4 pt-3 pb-1 resize-none focus:outline-none placeholder-slate-500 text-[15px] text-slate-100 leading-relaxed transition-[height] duration-150"
          style={{ maxHeight: 220 }}
        />
        {/* Workspace-connection chips (§8-40): recent-use-first; the pinned
            one joins the next agent run. Hidden when none exist. */}
        {(connections?.length ?? 0) > 0 && (
          <div data-testid="connector-chips" className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5">
            <Plug size={11} className="text-slate-500 shrink-0" aria-hidden="true" />
            {connections!.map((c) => {
              const pinned = pinnedConnectionId === c.id
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onTogglePinConnection?.(c.id)}
                  aria-pressed={pinned}
                  title={pinned ? `${c.name}: pinned — its tools join your next agent run. Click to unpin.` : `${c.name}: pin for the next run`}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] transition ${
                    pinned
                      ? 'border-[#c96442]/50 bg-[#c96442]/[0.08] text-[#e79d7f]'
                      : 'border-white/[0.08] text-slate-400 hover:text-slate-300 hover:bg-white/[0.04]'
                  }`}
                >
                  {pinned && <span aria-hidden="true">●</span>}
                  {c.name}
                </button>
              )
            })}
          </div>
        )}
        {/* The control row. P5: below sm it flex-wraps (icon+label chips,
            Send pinned via ml-auto) so scrollWidth never exceeds the box and
            no control (incl. the ml-auto Send wrapper) sits past innerWidth —
            the old row was one flat flex with zero breakpoint classes (455 in a 364 box). */}
        <div className="flex items-center gap-1.5 px-3 pb-2.5 pt-1 max-sm:flex-wrap">
          {/* + attach menu — short and task-oriented */}
          <PlusMenu
            open={showPlus}
            onToggle={onTogglePlus}
            onClose={onClosePlus}
            onCloseOther={() => {}}
            onPickFiles={() => fileInputRef.current?.click()}
            onScreenshot={captureScreen}
            canScreenshot={canScreenshot}
            onOpenConnectors={onOpenConnectors}
            onCreateImage={() => onInputChange('/image ')}
            onManageTools={() => onOpenSettingsTab('tools')}
            onRunBot={() => onInputChange('/bot ')}
          />

          {/* Run settings (Option A): ONE popover for Autonomy / Web search /
              Reasoning — replaces the three look-alike "· Auto" chips. */}
          <RunSettings
            runMode={runMode}
            webSearch={webSearch}
            thinking={thinking}
            onRunModeChange={onRunModeChange}
            onWebSearchChange={onToggleWebSearch}
            onThinkingChange={onToggleThinking}
          />

          {/* Hands-free voice mode (§8-44) — speak → listen → send loop. */}
          {voiceModeSupported && onToggleVoiceMode && (
            <button
              type="button"
              onClick={onToggleVoiceMode}
              aria-pressed={!!voiceMode}
              data-testid="voice-mode-toggle"
              title={voiceMode
                ? `Voice mode: on${voiceModeListening ? ' — listening…' : ''} — answers are spoken, the mic re-opens, and your speech sends. Click to turn off.`
                : 'Voice mode — speak answers aloud and reply hands-free'}
              aria-label={voiceMode ? 'Turn off hands-free voice mode' : 'Turn on hands-free voice mode'}
              className={`tap-target chip !px-2 ${voiceMode ? 'chip-live' : ''}`}
            >
              <AudioLines size={15} className={voiceModeListening ? 'animate-pulse' : ''} />
            </button>
          )}

          {/* Mic (STT dictation) — hidden on unsupported browsers */}
          {micSupported && !recording && (
            <button
              type="button"
              onClick={startDictation}
              title={t('mic')}
              aria-label={t('mic')}
              className="tap-target chip !px-2"
            >
              <Mic size={16} />
            </button>
          )}

          {/* Send / Stop — one morphing control (SendButton): disabled /
              ready / running(■) / queued(badge), token-colored, icon morph. */}
          <div className="ml-auto">
            <SendButton running={running} canSend={canSend} queuedCount={queuedCount} onStop={onStop} />
          </div>
        </div>
      </form>

      {typeof contextPct === 'number' && contextPct >= 8 && (
        <div
          className="mt-2 h-1 rounded-full bg-white/[0.06] overflow-hidden"
          title={`Context: ~${(contextTokens || 0).toLocaleString()} tokens used (~${contextPct}% of the 32k window)`}
          role="progressbar"
          aria-valuenow={contextPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Context window usage"
        >
          <div
            className={`h-full rounded-full transition-all ${contextPct > 85 ? 'bg-amber-400/80' : 'bg-slate-500/80'}`}
            style={{ width: `${contextPct}%` }}
          />
        </div>
      )}
      <p className="text-[11px] text-slate-500 text-center mt-2">
        {incognito ? <span className="text-[#e79d7f]/80">Incognito — private chat, no memory. </span> : null}
        {t('disclaimer')}
      </p>
    </div>
  )
}
