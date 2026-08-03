'use client'

import { useRef } from 'react'
import {
  Plus, Send, X, Zap, ClipboardCheck, Check, ChevronDown,
  Paperclip, Image as ImageIcon, Camera, Plug, Search, MessageSquare,
} from 'lucide-react'
import type { AgentMode } from '../../lib/api'

interface SlashCommand {
  cmd: string
  mode: AgentMode
  label: string
  icon: any
  hint: string
}

const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: '/research', mode: 'research', label: 'Deep Research', icon: Search, hint: 'Search the web and synthesise a cited answer' },
  { cmd: '/chat', mode: 'chat', label: 'Quick Chat', icon: MessageSquare, hint: 'Fast reply, no tools' },
]

interface ComposerProps {
  input: string
  imagePreview: string | null
  running: boolean
  runMode: 'auto' | 'plan' | 'accept'
  showSlash: boolean
  showPlus: boolean
  showModeMenu: boolean
  onInputChange: (value: string) => void
  onSelectSlashCommand: (cmd: string) => void
  onSend: (e?: React.FormEvent) => void
  onStop: () => void
  onImageSelected: (file: File) => void
  onRemoveImage: () => void
  onTogglePlus: () => void
  onClosePlus: () => void
  onToggleModeMenu: () => void
  onCloseModeMenu: () => void
  onRunModeChange: (mode: 'auto' | 'plan' | 'accept') => void
  onOpenConnectors: () => void
}

export default function Composer({
  input, imagePreview, running, runMode,
  showSlash, showPlus, showModeMenu,
  onInputChange, onSelectSlashCommand, onSend, onStop,
  onImageSelected, onRemoveImage,
  onTogglePlus, onClosePlus, onToggleModeMenu, onCloseModeMenu,
  onRunModeChange, onOpenConnectors,
}: ComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) onImageSelected(file)
  }

  const slashFilter = SLASH_COMMANDS.filter((c) =>
    c.cmd.startsWith((input.trim().split(/\s+/)[0] || '').toLowerCase())
  )

  const canSend = !!(input.trim() || imagePreview)

  return (
    <div className="relative">
      {/* Slash command popover */}
      {showSlash && slashFilter.length > 0 && (
        <div className="absolute bottom-full mb-2 left-0 right-0 glass rounded-xl border border-white/[0.08] overflow-hidden z-10 shadow-panel">
          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-widest text-slate-500 font-medium">
            Commands
          </div>
          {slashFilter.map((c) => {
            const Icon = c.icon
            return (
              <button
                key={c.cmd}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  onSelectSlashCommand(c.cmd + ' ')
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-white/[0.05] text-left transition"
              >
                <Icon size={15} className="text-slate-400 shrink-0" />
                <span className="min-w-0">
                  <span className="text-[13px] text-slate-200">{c.label} </span>
                  <span className="text-[12px] text-slate-500 font-mono">{c.cmd}</span>
                  <span className="block text-[12px] text-slate-500 truncate">{c.hint}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}

      {/* Image preview */}
      {imagePreview && (
        <div className="mb-2 relative inline-block">
          <img src={imagePreview} alt="preview" className="max-h-28 rounded-xl border border-white/10" />
          <button
            onClick={onRemoveImage}
            className="absolute -top-1.5 -right-1.5 p-1 bg-[#1a1a1d] rounded-full text-slate-300 border border-white/10 hover:bg-[#222226]"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Hidden file inputs */}
      <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageChange} className="hidden" />
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" onChange={handleImageChange} className="hidden" />

      {/* Input form */}
      <form
        onSubmit={onSend}
        className="rounded-2xl border border-white/[0.08] bg-[#1c1c1f] focus-within:border-white/[0.14] focus-within:bg-[#1f1f22] transition"
      >
        <textarea
          value={input}
          onChange={(e) => {
            const v = e.target.value
            onInputChange(v)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { /* close handled by parent */ }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend() }
          }}
          placeholder="Message Loop GPT…   ( / for commands )"
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
          {/* + attach menu */}
          <div className="relative">
            <button
              type="button"
              onClick={() => { onTogglePlus(); onCloseModeMenu() }}
              className={`w-8 h-8 flex items-center justify-center rounded-lg border transition ${
                showPlus
                  ? 'border-white/20 bg-white/10 text-slate-100'
                  : 'border-white/[0.08] text-slate-500 hover:bg-white/[0.05] hover:text-slate-300'
              }`}
            >
              <Plus size={18} />
            </button>
            {showPlus && (
              <div className="absolute bottom-full mb-2 left-0 w-52 glass rounded-xl border border-white/[0.08] overflow-hidden z-20 shadow-panel">
                <PlusItem icon={Paperclip} label="Upload a file" onClick={() => { onClosePlus(); fileInputRef.current?.click() }} />
                <PlusItem icon={ImageIcon} label="Add photo" onClick={() => { onClosePlus(); fileInputRef.current?.click() }} />
                <PlusItem icon={Camera} label="Take a photo" onClick={() => { onClosePlus(); cameraInputRef.current?.click() }} />
                <PlusItem icon={Plug} label="Connectors" onClick={() => { onClosePlus(); onOpenConnectors() }} />
              </div>
            )}
          </div>

          {/* Run mode picker */}
          <div className="relative">
            <button
              type="button"
              onClick={() => { onToggleModeMenu(); onClosePlus() }}
              className="h-8 px-2.5 flex items-center gap-1.5 rounded-lg border border-white/[0.08] text-slate-400 hover:bg-white/[0.05] hover:text-slate-200 text-xs transition"
            >
              {runMode === 'auto' ? <Zap size={13} /> : runMode === 'plan' ? <ClipboardCheck size={13} /> : <Check size={13} />}
              {runMode === 'auto' ? 'Auto' : runMode === 'plan' ? 'Plan' : 'Accept edits'}
              <ChevronDown size={12} className="text-slate-600" />
            </button>
            {showModeMenu && (
              <div className="absolute bottom-full mb-2 left-0 w-56 glass rounded-xl border border-white/[0.08] overflow-hidden z-20 shadow-panel">
                <ModeItem icon={Zap} label="Auto" hint="Agent decides and uses tools" active={runMode === 'auto'} onClick={() => { onRunModeChange('auto'); onCloseModeMenu() }} />
                <ModeItem icon={ClipboardCheck} label="Plan" hint="Outline a plan before acting" active={runMode === 'plan'} onClick={() => { onRunModeChange('plan'); onCloseModeMenu() }} />
                <ModeItem icon={Check} label="Accept edits" hint="Run all steps without pausing" active={runMode === 'accept'} onClick={() => { onRunModeChange('accept'); onCloseModeMenu() }} />
              </div>
            )}
          </div>

          {/* Send / Stop */}
          <div className="ml-auto">
            {running ? (
              <button
                type="button"
                onClick={onStop}
                title="Stop"
                className="w-9 h-9 flex items-center justify-center rounded-lg border border-white/[0.08] text-slate-300 hover:border-rose-400/30 hover:text-rose-400 transition"
              >
                <X size={18} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend}
                title="Send"
                className="w-9 h-9 flex items-center justify-center rounded-lg text-white bg-[#c96442] disabled:opacity-25 disabled:cursor-not-allowed hover:bg-[#b5593a] active:bg-[#a34e34] transition"
              >
                <Send size={16} />
              </button>
            )}
          </div>
        </div>
      </form>

      <p className="text-[11px] text-slate-700 mt-2 text-center">
        Loop GPT can make mistakes. Verify important info.
      </p>
    </div>
  )
}

function PlusItem({ icon: Icon, label, onClick }: { icon: any; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
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
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-white/[0.05] text-left transition"
    >
      <Icon size={15} className={`shrink-0 ${active ? 'text-[#c96442]' : 'text-slate-500'}`} />
      <span className="min-w-0 flex-1">
        <span className="text-[13px] text-slate-200">{label}</span>
        <span className="block text-[12px] text-slate-500">{hint}</span>
      </span>
      {active && <Check size={13} className="text-[#c96442] shrink-0" />}
    </button>
  )
}
