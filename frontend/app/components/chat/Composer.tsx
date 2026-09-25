'use client'

import { useEffect, useRef, useState } from 'react'
import { Send, X, Mic } from 'lucide-react'
import type { AgentMode } from '../../lib/api'
import { SLASH_SECTIONS, filterCommands } from '../../lib/commands'
import { useI18n } from '../../lib/i18n'
import { useDictation } from '../../lib/voice'
import { SlashPalette, RunModePicker } from './composer/SlashPalette'
import { PlusMenu, AttachmentChips, DictationBar } from './composer/PlusMenu'

export type RunMode = 'auto' | 'plan' | 'step' | 'accept'

interface ComposerProps {
  input: string
  imagePreviews: string[]
  docNames: string[]
  running: boolean
  runMode: RunMode
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
  onRemoveImage: (index: number) => void
  onRemoveDoc: (index: number) => void
  onTogglePlus: () => void
  onClosePlus: () => void
  onToggleModeMenu: () => void
  onCloseModeMenu: () => void
  onRunModeChange: (mode: RunMode) => void
  onOpenConnectors: () => void
  onOpenSettingsTab: (tab: string) => void
  /** Per-chat tool selection count ("N tools" chip); null = all (server default). */
  toolSelectionCount: number | null
}

/** Up to four attachments per turn. */
const MAX_IMAGES = 4

/** Chat composer: autogrowing textarea, slash palette (keyboard-navigable),
 * + attach menu, run-mode picker, mic dictation, send/stop, context meter. */
export default function Composer({
  input, imagePreviews, docNames, running, runMode, contextPct, contextTokens, incognito,
  showSlash, showPlus, showModeMenu,
  onInputChange, onSelectSlashCommand, onSend, onStop,
  onImagesSelected, onRemoveImage, onRemoveDoc,
  onTogglePlus, onClosePlus, onToggleModeMenu, onCloseModeMenu,
  onRunModeChange, onOpenConnectors, onOpenSettingsTab, toolSelectionCount,
}: ComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const [slashIndex, setSlashIndex] = useState(0)
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

  const canSend = !!(input.trim() || imagePreviews.length)

  return (
    <div className="relative">
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

      {/* Attachment previews: images + document chips (up to four total) */}
      <AttachmentChips
        imagePreviews={imagePreviews}
        docNames={docNames}
        onRemoveImage={onRemoveImage}
        onRemoveDoc={onRemoveDoc}
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
          className="w-full bg-transparent px-4 pt-3 pb-1 resize-none focus:outline-none placeholder-slate-600 text-[15px] text-slate-100 leading-relaxed"
          style={{ maxHeight: 220 }}
          onInput={(e) => {
            const el = e.target as HTMLTextAreaElement
            el.style.height = 'auto'
            el.style.height = Math.min(el.scrollHeight, 220) + 'px'
          }}
        />
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

          {/* Mic (STT dictation) — hidden on unsupported browsers */}
          {micSupported && !recording && (
            <button
              type="button"
              onClick={startDictation}
              title={t('mic')}
              aria-label={t('mic')}
              className="w-8 h-8 flex items-center justify-center rounded-lg border border-white/[0.08] text-slate-500 hover:bg-white/[0.05] hover:text-slate-300 transition"
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
                className="w-9 h-9 flex items-center justify-center rounded-lg border border-white/[0.08] text-slate-300 hover:border-rose-400/30 hover:text-rose-400 transition"
              >
                <X size={18} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend}
                title="Send"
                aria-label="Send message"
                className="w-9 h-9 flex items-center justify-center rounded-lg text-white bg-[#c96442] disabled:opacity-25 disabled:cursor-not-allowed hover:bg-[#b5593a] active:bg-[#a34e34] transition"
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
        <p className="text-[11px] text-slate-700 flex-1 text-center">
          {incognito ? <span className="text-[#e79d7f]/80">Incognito — private chat, no memory. </span> : null}
          {t('disclaimer')}
        </p>
      </div>
    </div>
  )
}
