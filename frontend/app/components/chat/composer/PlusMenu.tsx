'use client'

import { Plus, Image as ImageIcon, Camera, Plug, ListChecks, X, FileText, Mic, Square } from 'lucide-react'
import { useI18n } from '../../../lib/i18n'

/** The + attach menu: files, screenshot, connectors, create-image, tools.
 * `onClose` closes this menu (after a pick); `onCloseOther` closes the run
 * -mode menu when the trigger is clicked (menus are mutually exclusive). */
export function PlusMenu({
  open, onToggle, onClose, onCloseOther, onPickFiles, onScreenshot, canScreenshot,
  onOpenConnectors, onCreateImage, onManageTools, toolSelectionCount,
}: {
  open: boolean
  onToggle: () => void
  onClose: () => void
  onCloseOther: () => void
  onPickFiles: () => void
  onScreenshot: () => void
  canScreenshot: boolean
  onOpenConnectors: () => void
  onCreateImage: () => void
  onManageTools: () => void
  toolSelectionCount: number | null
}) {
  const { t } = useI18n()
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => { onToggle(); onCloseOther() }}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`w-8 h-8 flex items-center justify-center rounded-lg border transition ${
          open
            ? 'border-white/20 bg-white/10 text-slate-100'
            : 'border-white/[0.08] text-slate-500 hover:bg-white/[0.05] hover:text-slate-300'
        }`}
      >
        <Plus size={18} />
      </button>
      {open && (
        <div className="absolute bottom-full mb-2 left-0 w-56 glass rounded-xl border border-white/[0.08] overflow-hidden z-20 shadow-panel" role="menu">
          <PlusItem icon={ImageIcon} label={t('addFiles')} onClick={() => { onClose(); onPickFiles() }} />
          {canScreenshot && <PlusItem icon={Camera} label={t('takeScreenshot')} onClick={() => { onClose(); onScreenshot() }} />}
          <PlusItem icon={Plug} label={t('connectors')} onClick={() => { onClose(); onOpenConnectors() }} />
          <PlusItem icon={ImageIcon} label={t('createImage')} onClick={() => { onClose(); onCreateImage() }} />
          <div className="border-t border-white/[0.06]">
            <button
              type="button"
              onClick={() => { onClose(); onManageTools() }}
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

/** Attachment preview rows: image thumbnails + document chips (up to four
 * total per turn). */
export function AttachmentChips({
  imagePreviews, docNames, onRemoveImage, onRemoveDoc,
}: {
  imagePreviews: string[]
  docNames: string[]
  onRemoveImage: (index: number) => void
  onRemoveDoc: (index: number) => void
}) {
  return (
    <>
      {imagePreviews.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {imagePreviews.map((src, i) => (
            <div key={i} className="relative inline-block">
              <img src={src} alt={`preview ${i + 1}`} width={80} height={80} loading="lazy" decoding="async"
                className="h-20 w-20 object-cover rounded-xl border border-white/10" />
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
    </>
  )
}

/** Live dictation (STT) status bar with cancel / stop-and-send. */
export function DictationBar({
  elapsed, interim, onCancel, onStopAndSend,
}: {
  elapsed: number
  interim: string
  onCancel: () => void
  onStopAndSend: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="mb-2 flex items-center gap-3 px-3.5 py-2.5 rounded-xl border border-[#c96442]/40 bg-[#c96442]/10">
      <span className="relative flex items-center justify-center w-7 h-7">
        <Mic size={14} className="text-[#e79d7f] relative z-10" />
        <span className="absolute inset-0 rounded-full bg-[#c96442]/40 animate-ping" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-slate-200 font-medium">{t('listening')} {String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}</div>
        <div className="text-[11px] text-slate-500 truncate">{interim || t('recordingHint')}</div>
      </div>
      <button type="button" onClick={onCancel} className="px-2.5 py-1.5 rounded-lg text-[12px] text-slate-300 hover:bg-white/5 transition">{t('cancelRecording')}</button>
      <button type="button" onClick={onStopAndSend} className="px-2.5 py-1.5 rounded-lg text-[12px] font-medium text-white bg-[#c96442] hover:bg-[#b5593a] transition flex items-center gap-1"><Square size={10} /> Send</button>
    </div>
  )
}
