'use client'

import { useCallback, useState } from 'react'
import { Keyboard } from 'lucide-react'
import { Dialog } from '@loop/ui'
import { useHotkey } from '../lib/useHotkey'
import { modLabel } from '../lib/platformKey'

function shortcutRows() {
  const mod = modLabel()
  return [
    { keys: `${mod} K`, label: 'Command palette' },
    { keys: `${mod} L`, label: 'New conversation' },
    { keys: `${mod} B`, label: 'Toggle sidebar' },
    { keys: `${mod} Enter`, label: 'Send message' },
    { keys: `${mod} ↑ / ${mod} ↓`, label: 'Conversation history' },
    { keys: '↑ / ↓', label: 'Prompt history' },
    { keys: `${mod} Z / ${mod} Y`, label: 'Undo / redo' },
    { keys: 'Esc', label: 'Close popover / Cancel' },
    { keys: '/', label: 'Commands (in chat box)' },
  ]
}

interface Props {
  /** When provided, the sheet is controlled by the parent and the `?` hotkey
   *  is bound to `onOpenChange(true)`. When omitted, the sheet manages its
   *  own open state via the `?` key. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function ShortcutSheet({ open: controlledOpen, onOpenChange }: Props = {}) {
  const [internalOpen, setInternalOpen] = useState(false)
  const isControlled = controlledOpen !== undefined && onOpenChange !== undefined
  const open = isControlled ? controlledOpen : internalOpen
  const setOpen = useCallback((next: boolean) => {
    if (isControlled) onOpenChange!(next)
    else setInternalOpen(next)
  }, [isControlled, onOpenChange])

  useHotkey({ key: '?' }, () => setOpen(true))

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      ariaLabel="Keyboard shortcuts"
      align="top"
      size="sm"
    >
      <div className="flex items-center gap-2 mb-4">
        <Keyboard size={16} className="text-slate-500" />
        <span className="text-[14px] font-medium text-slate-200">Keyboard shortcuts</span>
      </div>
      <div className="space-y-2">
        {shortcutRows().map((s) => (
          <div key={s.keys} className="flex items-center justify-between text-[13px]">
            <span className="text-slate-400">{s.label}</span>
            <kbd className="font-mono text-[12px] text-slate-500 bg-white/[0.04] px-2 py-0.5 rounded">{s.keys}</kbd>
          </div>
        ))}
      </div>
    </Dialog>
  )
}
