'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Plus, Send, X, Zap, ClipboardCheck, Check, ChevronDown, ListChecks,
  Paperclip, Image as ImageIcon, Camera, Plug, Search, MessageSquare,
  FilePlus, RotateCcw, Download as DownloadIcon, Settings2 as Settings2Icon,
  Mic, Square, FolderKanban, Blocks, Puzzle, Cable, FileText,
} from 'lucide-react'
import type { AgentMode } from '../../lib/api'
import { API_URL, authHeaders } from '../../lib/api'
import { useI18n } from '../../lib/i18n'
import { SLASH_SECTIONS, filterCommands, type SlashCommandDef } from '../../lib/commands'
import { useDictation } from '../../lib/voice'

/** Map a command to a representative icon. */
const ICONS: Record<string, any> = {
  '/chat': MessageSquare, '/agent': Zap, '/research': Search, '/image': ImageIcon,
  '/video': Paperclip, '/create': FilePlus, '/memory': MessageSquare,
  '/new': Plus, '/undo': RotateCcw, '/retry': RotateCcw, '/stop': X, '/export': DownloadIcon,
  '/screenshot': Camera, '/model': ChevronDown, '/settings': Settings2Icon, '/help': Search,
  '/skills': Blocks, '/projects': FolderKanban, '/connectors': Cable, '/plugins': Puzzle,
}
function iconFor(def: SlashCommandDef) { return ICONS[def.cmd] || MessageSquare }

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

/** Up to four images per turn. */
const MAX_IMAGES = 4

const MODES: Array<{ id: RunMode; label: string; hint: string; icon: any }> = [
  { id: 'auto', label: 'Auto', hint: 'Agent decides and uses tools', icon: Zap },
  { id: 'plan', label: 'Plan', hint: 'Outline a plan before acting', icon: ClipboardCheck },
  { id: 'step', label: 'Ask first', hint: 'Confirm before every action', icon: ListChecks },
  { id: 'accept', label: 'Accept edits', hint: 'Run all steps without pausing', icon: Check },
]

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
  const activeMode = MODES.find((m) => m.id === runMode) || MODES[0]
  const ActiveIcon = activeMode.icon

  return (
    <div className="relative">
      {/* ── Slash command palette (light, compact) ─────────────────────────── */}
      {showSlash && slashFilter.length > 0 && (
        <div className="absolute bottom-full mb-2 left-0 right-0 glass rounded-xl border border-white/[0.08] overflow-hidden z-10 shadow-panel max-h-80 overflow-y-auto">
          {SLASH_SECTIONS.map((section) => {
            const items = slashFilter.filter((c) => c.section === section)
            if (!items.length) return null
            return (
              <div key={section}>
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-widest text-slate-600 font-medium">{section}</div>
                {items.map((c) => {
                  const idx = slashFilter.indexOf(c)
                  const Icon = iconFor(c)
                  const highlighted = idx === slashIndex
                  return (
                    <button
                      key={c.cmd}
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); handleCommandClick(c.cmd) }}
                      onMouseEnter={() => setSlashIndex(idx)}
                      data-slash-index={idx}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition ${
                        highlighted ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'
                      }`}
                    >
                      <Icon size={14} className={highlighted ? 'text-[#c96442] shrink-0' : 'text-slate-500 shrink-0'} />
                      <span className="text-[13px] text-slate-200">{c.label}</span>
                      <span className="ml-auto text-[11px] font-mono text-slate-600">{c.cmd}</span>
                    </button>
                  )
                })}
              </div>
            )
          })}
          {/* Hint line — only for the highlighted command (cuts visual weight). */}
          <div className="px-3 py-1.5 border-t border-white/[0.05] text-[11px] text-slate-500 truncate">
            {slashFilter[slashIndex]?.hint || t('commands')}
          </div>
        </div>
      )}

      {/* Attachment previews: images + document chips (up to four total) */}
      {imagePreviews.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {imagePreviews.map((src, i) => (
            <div key={i} className="relative inline-block">
              <img src={src} alt={`preview ${i + 1}`} className="h-20 w-20 object-cover rounded-xl border border-white/10" />
              <button
                type="button"
                onClick={() => onRemoveImage(i)}
                aria-label={`Remove image ${i + 1}`}
                className="absolute -top-1.5 -right-1.5 p-1 bg-[#1a1a1d] rounded-full text-slate-300 border border-white/10 hover:bg-[#222226]"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {docNames.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {docNames.map((name, i) => (
            <div key={name + i} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-white/10 bg-white/[0.03]">
              <FileText size={13} className="text-slate-400 shrink-0" />
              <span className="text-[12px] text-slate-200 truncate max-w-[180px]">{name}</span>
              <button type="button" onClick={() => onRemoveDoc(i)} aria-label={`Remove ${name}`} className="p-0.5 text-slate-500 hover:text-rose-400">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Recording state */}
      {recording && (
        <div className="mb-2 flex items-center gap-3 px-3.5 py-2.5 rounded-xl border border-[#c96442]/40 bg-[#c96442]/10">
          <span className="relative flex items-center justify-center w-7 h-7">
            <Mic size={14} className="text-[#e79d7f] relative z-10" />
            <span className="absolute inset-0 rounded-full bg-[#c96442]/40 animate-ping" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] text-slate-200 font-medium">{t('listening')} {String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}</div>
            <div className="text-[11px] text-slate-500 truncate">{interim || t('recordingHint')}</div>
          </div>
          <button type="button" onClick={stopDictation} className="px-2.5 py-1.5 rounded-lg text-[12px] text-slate-300 hover:bg-white/5 transition">{t('cancelRecording')}</button>
          <button type="button" onClick={stopAndSend} className="px-2.5 py-1.5 rounded-lg text-[12px] font-medium text-white bg-[#c96442] hover:bg-[#b5593a] transition flex items-center gap-1"><Square size={10} /> Send</button>
        </div>
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
          <div className="relative">
            <button
              type="button"
              onClick={() => { onTogglePlus(); onCloseModeMenu() }}
              aria-haspopup="menu"
              aria-expanded={showPlus}
              className={`w-8 h-8 flex items-center justify-center rounded-lg border transition ${
                showPlus
                  ? 'border-white/20 bg-white/10 text-slate-100'
                  : 'border-white/[0.08] text-slate-500 hover:bg-white/[0.05] hover:text-slate-300'
              }`}
            >
              <Plus size={18} />
            </button>
            {showPlus && (
              <div className="absolute bottom-full mb-2 left-0 w-56 glass rounded-xl border border-white/[0.08] overflow-hidden z-20 shadow-panel" role="menu">
                <PlusItem icon={ImageIcon} label={t('addFiles')} onClick={() => { onClosePlus(); fileInputRef.current?.click() }} />
                {canScreenshot && <PlusItem icon={Camera} label={t('takeScreenshot')} onClick={() => { onClosePlus(); captureScreen() }} />}
                <PlusItem icon={Plug} label={t('connectors')} onClick={() => { onClosePlus(); onOpenConnectors() }} />
                <PlusItem icon={ImageIcon} label={t('createImage')} onClick={() => { onClosePlus(); onInputChange('/image '); }} />
                <div className="border-t border-white/[0.06]">
                  <button
                    type="button"
                    onClick={() => { onClosePlus(); onOpenSettingsTab('tools') }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-white/[0.05] text-left text-[13px] text-slate-200 transition"
                    role="menuitem"
                  >
                    <ListChecks size={15} className="text-slate-500 shrink-0" />
                    <span className="flex-1">{t('manageTools')}</span>
                    <span className="text-[11px] text-slate-600">{toolSelectionCount === null ? 'All' : `${toolSelectionCount}`}</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Run mode picker — icon + label + active ring on the collapsed button */}
          <div className="relative">
            <button
              type="button"
              onClick={() => { onToggleModeMenu(); onClosePlus() }}
              aria-haspopup="menu"
              aria-expanded={showModeMenu}
              title={activeMode.hint}
              className={`h-8 px-2.5 flex items-center gap-1.5 rounded-lg border transition ${
                runMode !== 'auto'
                  ? 'border-[#c96442]/40 text-[#e79d7f] bg-[#c96442]/[0.07]'
                  : 'border-white/[0.08] text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
              } text-xs`}
            >
              <ActiveIcon size={13} />
              {activeMode.label}
              <ChevronDown size={12} className="text-slate-600" />
            </button>
            {showModeMenu && (
              <div className="absolute bottom-full mb-2 left-0 w-60 glass rounded-xl border border-white/[0.08] overflow-hidden z-20 shadow-panel" role="menu">
                {MODES.map((m) => (
                  <ModeItem key={m.id} icon={m.icon} label={m.label} hint={m.hint} active={runMode === m.id}
                    onClick={() => { onRunModeChange(m.id); onCloseModeMenu() }} />
                ))}
              </div>
            )}
          </div>

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

function PlusItem({ icon: Icon, label, onClick }: { icon: any; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-white/[0.05] text-left text-[13px] text-slate-200 transition"
    >
      <Icon size={15} className="text-slate-500 shrink-0" /> {label}
    </button>
  )
}

function ModeItem({
  icon: Icon, label, hint, active, onClick,
}: {
  icon: any; label: string; hint: string; active?: boolean; onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-white/[0.05] text-left transition"
    >
      <Icon size={15} className={`shrink-0 ${active ? 'text-[#c96442]' : 'text-slate-500'}`} />
      <span className="min-w-0 flex-1">
        <span className={`text-[13px] ${active ? 'text-slate-100 font-medium' : 'text-slate-200'}`}>{label}</span>
        <span className="block text-[12px] text-slate-500">{hint}</span>
      </span>
      {active && <Check size={13} className="text-[#c96442] shrink-0" />}
    </button>
  )
}
