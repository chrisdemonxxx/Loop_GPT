'use client'

import { useEffect } from 'react'
import { Monitor, Zap, Volume2, Sparkles } from 'lucide-react'
import { usePrefs, applyPrefsSideEffects, type MotionChoice, type ChatFontChoice } from '../../lib/prefs'
import { SectionHeader, Toggle } from '../ui/primitives'

const MOTIONS: Array<{ id: MotionChoice; label: string; hint: string }> = [
  { id: 'system', label: 'System', hint: 'Follows your device setting' },
  { id: 'reduced', label: 'Reduced', hint: 'Calm the interface down' },
]

const FONTS: Array<{ id: ChatFontChoice; label: string; hint: string }> = [
  { id: 'compact', label: 'Compact', hint: 'More on screen' },
  { id: 'comfortable', label: 'Comfortable', hint: 'The default' },
  { id: 'spacious', label: 'Spacious', hint: 'Easier to read' },
]

const VOICE_LANGUAGES = ['en-US', 'en-GB', 'es-ES', 'fr-FR', 'de-DE', 'pt-BR', 'tr-TR', 'zh-CN']

/**
 * General (blueprint §8): motion, chat font, notifications, voice — the
 * client-pref half of the blueprint's General panel. The theme lives next
 * door in Appearance (two-surface split, contract §1); the voice engine +
 * server voice selection stay in Personalization.
 */
export default function GeneralTab() {
  const { prefs, update } = usePrefs()

  // The font scale + motion markers own document-level side effects.
  useEffect(() => { applyPrefsSideEffects(prefs) }, [prefs.chatFontSize, prefs.motion, prefs.codeTheme, prefs.codeFont]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-5">
      <SectionHeader title="Appearance & motion" />
      <div role="radiogroup" aria-label="Motion" className="grid grid-cols-2 gap-2.5">
        {MOTIONS.map(({ id, label, hint }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={prefs.motion === id}
            onClick={() => update({ motion: id })}
            className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-[13px] transition ${
              prefs.motion === id
                ? 'border-[#c96442]/50 bg-[#c96442]/[0.08] text-[#e79d7f]'
                : 'border-white/[0.08] text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]'
            }`}
          >
            <Monitor size={14} />
            <span className="min-w-0">
              <span className="block font-medium">{label}</span>
              <span className="block text-[11px] text-slate-500">{hint}</span>
            </span>
          </button>
        ))}
      </div>

      <SectionHeader title="Chat font" />
      <div role="radiogroup" aria-label="Chat font" className="grid grid-cols-3 gap-2.5">
        {FONTS.map(({ id, label, hint }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={prefs.chatFontSize === id}
            onClick={() => update({ chatFontSize: id })}
            className={`flex flex-col items-center gap-1 rounded-xl border px-3 py-3 text-[13px] transition ${
              prefs.chatFontSize === id
                ? 'border-[#c96442]/50 bg-[#c96442]/[0.08] text-[#e79d7f]'
                : 'border-white/[0.08] text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]'
            }`}
          >
            <span className="font-medium">{label}</span>
            <span className="text-[11px] text-slate-500">{hint}</span>
          </button>
        ))}
      </div>

      <SectionHeader title="Notifications" />
      <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] px-3.5 py-3">
        <span className="flex min-w-0 items-start gap-2.5 text-[13px]">
          <Sparkles size={14} className="mt-0.5 shrink-0 text-slate-500" />
          <span>
            <span className="block text-slate-300">Response completions</span>
            <span className="block text-[11px] text-slate-500">Notify when a long-running reply finishes</span>
          </span>
        </span>
        <Toggle on={prefs.notifications} onChange={(on) => update({ notifications: on })} label="Response completions" />
      </div>

      <SectionHeader title="Voice" />
      <div className="space-y-3 rounded-xl border border-white/[0.06] p-3.5">
        <label className="flex items-center justify-between gap-3 text-[13px]">
          <span className="flex items-center gap-2 text-slate-300"><Volume2 size={14} className="text-slate-500" /> Dictation language</span>
          <select
            aria-label="Dictation language"
            value={prefs.voiceLanguage}
            onChange={(e) => update({ voiceLanguage: e.target.value })}
            className="rounded-lg border border-white/10 bg-[#14141f] px-2.5 py-1.5 text-[12px] text-slate-200 focus:border-[#c96442]/50 focus:outline-none"
          >
            {VOICE_LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label className="flex items-center justify-between gap-3 text-[13px]">
          <span className="flex items-center gap-2 text-slate-300"><Zap size={14} className="text-slate-500" /> Speech speed</span>
          <span className="flex items-center gap-2">
            <input
              type="range" min={0.5} max={2} step={0.25}
              aria-label="Speech speed"
              value={prefs.voiceSpeed}
              onChange={(e) => update({ voiceSpeed: Number(e.target.value) })}
              className="w-28 accent-[#c96442]"
            />
            <span className="w-9 text-right text-[12px] tabular-nums text-slate-400">{prefs.voiceSpeed.toFixed(2)}×</span>
          </span>
        </label>
      </div>
    </div>
  )
}