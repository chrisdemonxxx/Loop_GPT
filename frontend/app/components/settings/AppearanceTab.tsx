'use client'

import { Sun, Moon, Monitor, Info } from 'lucide-react'
import { useTheme, type ThemeChoice } from '../../lib/theme'
import { SectionHeader } from '../ui/primitives'

const CHOICES: Array<{ id: ThemeChoice; label: string; Icon: typeof Sun; hint: string }> = [
  { id: 'light', label: 'Light', Icon: Sun, hint: 'Warm paper surfaces' },
  { id: 'dark', label: 'Dark', Icon: Moon, hint: 'The default look' },
  { id: 'system', label: 'System', Icon: Monitor, hint: 'Follows your device' },
]

/**
 * Appearance (audit §8-36): the explicit light/dark/system theme choice —
 * the header button cycles the same setting; this tab exposes all three
 * states directly. Profile, usage and data controls remain on /account.
 */
export default function AppearanceTab() {
  const theme = useTheme()
  return (
    <div className="space-y-4">
      <SectionHeader title="Theme" />
      <div role="radiogroup" aria-label="Theme" data-testid="theme-choices" className="grid grid-cols-3 gap-2.5">
        {CHOICES.map(({ id, label, Icon, hint }) => {
          const selected = theme.choice === id
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => theme.setChoice(id)}
              className={`flex flex-col items-center gap-1.5 rounded-xl border px-3 py-4 text-[13px] transition ${
                selected
                  ? 'border-[#c96442]/50 bg-[#c96442]/[0.08] text-[#e79d7f]'
                  : 'border-white/[0.08] text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]'
              }`}
            >
              <Icon size={18} />
              <span className="font-medium">{label}</span>
              <span className="text-[11px] text-slate-500">{hint}</span>
            </button>
          )
        })}
      </div>
      <div className="flex items-start gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-[12px] text-slate-400">
        <Info size={13} className="mt-0.5 shrink-0 text-slate-500" />
        <span>
          System follows your device preference live. Profile details, plan usage and data controls
          (export/delete) live on your <a href="/account" className="text-[#c96442] hover:underline">account page</a>.
        </span>
      </div>
    </div>
  )
}
