'use client'

import { useEffect, useRef, useState } from 'react'
import { Send, X, Mic, UploadCloud, Globe, Brain, Plug, AudioLines } from 'lucide-react'
import type { AgentMode } from '../../lib/api'
import { SLASH_SECTIONS, filterCommands } from '../../lib/commands'
import { useI18n } from '../../lib/i18n'
import { useDictation } from '../../lib/voice'
import type { PendingAttachment } from '../../chat/hooks'
import { SlashPalette, RunModePicker, TriStateToggle, type ToggleState } from './composer/SlashPalette'
import { PlusMenu, AttachmentChips, DictationBar } from './composer/PlusMenu'

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
  /** Extended-thinking override (§8-26): same tri-state contract. */
  thinking: ToggleState
  onToggleThinking: (next: ToggleState) => void
  /** Context meter (§2.5): 0-100 estimated window usage. */
  contextPct?: number
  contextTokens?: number
  incognito?: boolean
  showSlash: boolean
  showPlus: boolean
  showModeMenu: boolean
  onInputChange: (value: string) => void
  onSelectSlashCommand: (cmd: string) => void
  onSend: (e?: React.FormEvent) => void
  onStop: () => void
  onImagesSelected: (files: File[]) => void
  onTogglePlus: () => void
  onClosePlus: () => void
  onToggleModeMenu: () => void
  onCloseModeMenu: () => void
  onRunModeChange: (mode: RunMode) => void
  onOpenConnectors: () => void
  onOpenSettingsTab: (tab: string) => void
  /** Per-chat tool selection count ("N tools" chip); null = all (server default). */
  toolSelectionCount: number | null
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
  showSlash, showPlus, showModeMenu,
  onInputChange, onSelectSlashCommand, onSend, onStop,
  onImagesSelected,
  onTogglePlus, onClosePlus, onToggleModeMenu, onCloseModeMenu,
  onRunModeChange, onOpenConnectors, onOpenSettingsTab, toolSelectionCount,
  connections, pinnedConnectionId, onTogglePinConnection,
  voiceMode, voiceModeSupported, voiceModeListening, onToggleVoiceMode,
}: ComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const [slashIndex, setSlashIndex] = useState(0)
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
      {/* ── Slash command palette (light, compact) ─────────────────────────── */}
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

      {/* Attachment previews: image thumbnails + document chips with upload
          progress and visible error/ retry states (up to four per turn). */}
      <AttachmentChips
        attachments={attachments}
        onRemove={onRemoveAttachment}
        onRetry={onRetryAttachment}
      />

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
        className={`rounded-2xl border bg-[#1c1c1f] transition ${recording ? 'border-[#c96442]/40' : 'border-white/[0.08] focus-within:border-white/[0.14] focus-within:bg-[#1f1f22]'}`}
      >
        <textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && showSlash && slashFilter.length > 0) {
              e.preventDefault()
              setSlashIndex((i) => (i + 1) % slashFilter.length)
            } else if (e.key === 'ArrowUp' && showSlash && slashFilter.length > 0) {
              e.preventDefault()
              setSlashIndex((i) => (i - 1 + slashFilter.length) % slashFilter.length)
            } else if (e.key === 'Tab' && showSlash && slashFilter.length > 0) {
              e.preventDefault()
              handleCommandClick(slashFilter[slashIndex]?.cmd)
            } else if (e.key === 'Enter' && !e.shiftKey) {
              if (showSlash && slashFilter.length > 0 && input.trim() === (slashFilter[slashIndex]?.cmd || slashFilter[0]?.cmd)) {
                e.preventDefault()
                handleCommandClick((slashFilter[slashIndex] || slashFilter[0]).cmd)
              } else { e.preventDefault(); onSend() }
            }
          }}
          aria-label={t('placeholder')}
          placeholder={t('placeholder')}
          rows={1}
          className="w-full bg-transparent px-4 pt-3 pb-1 resize-none focus:outline-none placeholder-slate-500 text-[15px] text-slate-100 leading-relaxed"
          style={{ maxHeight: 220 }}
          onInput={(e) => {
            const el = e.target as HTMLTextAreaElement
            el.style.height = 'auto'
            el.style.height = Math.min(el.scrollHeight, 220) + 'px'
          }}
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
        <div className="flex items-center gap-1.5 px-3 pb-2.5 pt-1">
          {/* + attach menu — short and task-oriented */}
          <PlusMenu
            open={showPlus}
            onToggle={onTogglePlus}
            onClose={onClosePlus}
            onCloseOther={onCloseModeMenu}
            onPickFiles={() => fileInputRef.current?.click()}
            onScreenshot={captureScreen}
            canScreenshot={canScreenshot}
            onOpenConnectors={onOpenConnectors}
            onCreateImage={() => onInputChange('/image ')}
            onManageTools={() => onOpenSettingsTab('tools')}
            toolSelectionCount={toolSelectionCount}
          />

          {/* Run mode picker — icon + label + active ring on the collapsed button */}
          <RunModePicker
            runMode={runMode}
            open={showModeMenu}
            onToggle={onToggleModeMenu}
            onClose={onCloseModeMenu}
            onCloseOther={onClosePlus}
            onChange={onRunModeChange}
          />

          {/* Web-search toggle (§8-25) — cycles Auto → On → Off */}
          <TriStateToggle
            icon={Globe}
            kind="web"
            state={webSearch}
            onCycle={onToggleWebSearch}
            titleFor={(s) => s === 'auto'
              ? 'Web search: auto — the tool selection decides'
              : s === 'on'
                ? 'Web search: on — force web tools into this run'
                : 'Web search: off — strip web tools from this run'}
          />

          {/* Extended-thinking toggle (§8-26) — cycles Auto → On → Off */}
          <TriStateToggle
            icon={Brain}
            kind="thinking"
            state={thinking}
            onCycle={onToggleThinking}
            titleFor={(s) => s === 'auto'
              ? 'Extended thinking: auto — model default'
              : s === 'on'
                ? 'Extended thinking: on — deeper reasoning for this run'
                : 'Extended thinking: off — answer directly for this run'}
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
              className={`tap-target p-1.5 rounded-lg border transition ${
                voiceMode
                  ? 'border-[#c96442]/50 text-[#e79d7f] bg-[#c96442]/[0.08]'
                  : 'border-transparent text-slate-400 hover:text-slate-300 hover:bg-white/[0.05]'
              }`}
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
              className="tap-target w-8 h-8 flex items-center justify-center rounded-lg border border-white/[0.08] text-slate-400 hover:bg-white/[0.05] hover:text-slate-300 transition"
            >
              <Mic size={16} />
            </button>
          )}

          {/* Send / Stop */}
          <div className="ml-auto">
            {running ? (
              <button
                type="button"
                onClick={onStop}
                title="Stop"
                aria-label="Stop response"
                className="tap-target w-9 h-9 flex items-center justify-center rounded-lg border border-white/[0.08] text-slate-300 hover:border-rose-400/30 hover:text-rose-400 transition"
              >
                <X size={18} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend}
                title="Send"
                aria-label="Send message"
                className="tap-target w-9 h-9 flex items-center justify-center rounded-lg text-white bg-[#c96442] disabled:opacity-25 disabled:cursor-not-allowed hover:bg-[#b5593a] active:bg-[#a34e34] transition"
              >
                <Send size={16} />
              </button>
            )}
          </div>
        </div>
      </form>

      <div className="flex items-center gap-3 mt-2">
        {typeof contextPct === 'number' && (
          <div
            className="flex-1 h-1 rounded-full bg-white/[0.05] overflow-hidden"
            title={`Context: ~${(contextTokens || 0).toLocaleString()} tokens used (~${contextPct}% of the 32k window)`}
            role="progressbar"
            aria-valuenow={contextPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Context window usage"
          >
            <div
              className={`h-full rounded-full transition-all ${contextPct > 85 ? 'bg-amber-400/80' : 'bg-slate-600/70'}`}
              style={{ width: `${Math.max(contextPct, 1.5)}%` }}
            />
          </div>
        )}
        <p className="text-[11px] text-slate-500 flex-1 text-center">
          {incognito ? <span className="text-[#e79d7f]/80">Incognito — private chat, no memory. </span> : null}
          {t('disclaimer')}
        </p>
      </div>
    </div>
  )
}
