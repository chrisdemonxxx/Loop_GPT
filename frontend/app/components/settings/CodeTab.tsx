'use client'

import { useEffect } from 'react'
import { Terminal, ArrowRight, Moon, Sun } from 'lucide-react'
import Link from 'next/link'
import { usePrefs, applyPrefsSideEffects, type CodeThemeChoice, type CodeFontChoice } from '../../lib/prefs'
import { SectionHeader } from '../ui/primitives'

const CODE_THEMES: Array<{ id: CodeThemeChoice; label: string; Icon: typeof Sun }> = [
  { id: 'dark', label: 'Dark', Icon: Moon },
  { id: 'light', label: 'Light', Icon: Sun },
]

const CODE_FONTS: Array<{ id: CodeFontChoice; label: string; hint: string }> = [
  { id: 'mono', label: 'Loop Mono', hint: 'The default' },
  { id: 'serif-mono', label: 'Serif Mono', hint: 'Softer on the eyes' },
  { id: 'system-mono', label: 'System Mono', hint: 'Follows your OS' },
]

/**
 * Loop Code (blueprint's "Claude Code" panel, §8): code-block appearance for
 * every fenced/rendered surface, plus the hand-off to the /developer product
 * page. No upgrade-gate fiction — nothing in our product gates this today.
 */
export default function CodeTab() {
  const { prefs, update } = usePrefs()
  useEffect(() => { applyPrefsSideEffects(prefs) }, [prefs.codeTheme, prefs.codeFont]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-5">
      <SectionHeader title="Code appearance" />

      <div role="radiogroup" aria-label="Code theme" className="grid grid-cols-2 gap-2.5">
        {CODE_THEMES.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={prefs.codeTheme === id}
            onClick={() => update({ codeTheme: id })}
            className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-[13px] transition ${
              prefs.codeTheme === id
                ? 'border-[#c96442]/50 bg-[#c96442]/[0.08] text-[#e79d7f]'
                : 'border-white/[0.08] text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]'
            }`}
          >
            <Icon size={14} />
            <span>
              <span className="block font-medium">{label} code theme</span>
              <span className="block text-[11px] text-slate-500">{id === 'dark' ? 'Atom One Dark' : 'matches light surfaces'}</span>
            </span>
          </button>
        ))}
      </div>

      <SectionHeader title="Code font" />
      <div role="radiogroup" aria-label="Code font" className="grid grid-cols-3 gap-2.5">
        {CODE_FONTS.map(({ id, label, hint }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={prefs.codeFont === id}
            onClick={() => update({ codeFont: id })}
            className={`flex flex-col items-center gap-1 rounded-xl border px-3 py-3 text-[13px] transition ${
              prefs.codeFont === id
                ? 'border-[#c96442]/50 bg-[#c96442]/[0.08] text-[#e79d7f]'
                : 'border-white/[0.08] text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]'
            }`}
          >
            <span className="font-medium" style={{ fontFamily: 'var(--code-font-family, ui-monospace)' }}>{label}</span>
            <span className="text-[11px] text-slate-500">{hint}</span>
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-white/[0.06] p-3.5">
        <div className="text-[13px] text-slate-300">Loop Code CLI</div>
        <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
          The companion CLI runs the same tools and memory in your terminal.
        </p>
        <Link
          href="/developer"
          className="mt-2.5 inline-flex items-center gap-2 rounded-xl border border-[#c96442]/40 bg-[#c96442]/[0.08] px-4 py-2 text-[13px] font-medium text-[#e79d7f] transition hover:bg-[#c96442]/[0.14]"
        >
          <Terminal size={14} /> Get Loop Code <ArrowRight size={13} />
        </Link>
      </div>
    </div>
  )
}