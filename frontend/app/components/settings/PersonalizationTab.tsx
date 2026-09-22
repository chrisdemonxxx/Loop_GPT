'use client'

import { useEffect, useState } from 'react'
import { Feather, Loader2, PenLine, Sparkles, Trash2, Volume2 } from 'lucide-react'
import { API_URL, authHeaders } from '../../lib/api'
import { Badge, btnGhost, btnPrimary, Card, EmptyState, inputCls, SectionHeader } from '../ui/primitives'

interface StyleRow { id: string; name: string; systemPrompt: string; isDefault: boolean }

/** Built-in preset gallery (Claude-style). Selecting one makes it the default
 * style by writing it as the user's active UserStyle. */
const PRESETS = [
  { key: 'normal', name: 'Normal', prompt: 'Respond in your default, balanced way: clear and natural prose, standard length for the question.', description: 'The default, balanced tone' },
  { key: 'concise', name: 'Concise', prompt: 'Keep responses short and to the point. Prefer one-to-three sentences unless the user asks for detail. No filler.', description: 'Shorter answers, no filler' },
  { key: 'explanatory', name: 'Explanatory', prompt: 'Explain your reasoning as you answer. Add context, examples, and the "why" behind the answer so the user learns.', description: 'Educational answers with context' },
  { key: 'formal', name: 'Formal', prompt: 'Write in a polished, professional register. Complete sentences, precise vocabulary, no slang or emoji.', description: 'Polished, professional register' },
]

function loadVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !window.speechSynthesis) return []
  return window.speechSynthesis.getVoices()
}

/**
 * Personalization (Claude-style styles): preset gallery, create-your-own,
 * create-from-writing-sample, active style display, and voice preferences.
 */
export default function PersonalizationTab() {
  const [styles, setStyles] = useState<StyleRow[]>([])
  const [activePreset, setActivePreset] = useState<string | null>(null)
  const [creating, setCreating] = useState<null | 'custom' | 'sample'>(null)
  const [form, setForm] = useState({ name: '', systemPrompt: '' })
  const [sample, setSample] = useState('')
  const [sampleBusy, setSampleBusy] = useState(false)
  const [error, setError] = useState('')

  // Voice preferences (TTS read-aloud).
  const [voiceName, setVoiceName] = useState('')
  const [rate, setRate] = useState(1)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])

  const load = () =>
    fetch(`${API_URL}/api/styles`, { headers: authHeaders() }).then((r) => r.json()).then((d) => setStyles(Array.isArray(d) ? d : [])).catch(() => {})
  useEffect(() => { load() }, [])

  // Load saved voice prefs + available voices.
  useEffect(() => {
    try {
      setVoiceName(localStorage.getItem('voiceName') || '')
      setRate(Number(localStorage.getItem('voiceRate')) || 1)
    } catch { /* ignore */ }
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      const update = () => setVoices(loadVoices().filter((v) => v.lang.startsWith('en') || v.lang.startsWith('fr')))
      update()
      window.speechSynthesis.onvoiceschanged = update
    }
  }, [])

  const saveVoicePrefs = (nextVoice?: string, nextRate?: number) => {
    const v = nextVoice !== undefined ? nextVoice : voiceName
    const r = nextRate !== undefined ? nextRate : rate
    try { localStorage.setItem('voiceName', v); localStorage.setItem('voiceRate', String(r)) } catch { /* ignore */ }
  }

  // Which preset is active: the default style whose prompt matches a preset.
  const defaultStyle = styles.find((s) => s.isDefault)
  useEffect(() => {
    if (defaultStyle) {
      const match = PRESETS.find((p) => p.prompt === defaultStyle.systemPrompt || p.name.toLowerCase() === defaultStyle.name.toLowerCase())
      setActivePreset(match ? match.key : null)
    } else setActivePreset('normal')
  }, [defaultStyle?.id, defaultStyle?.systemPrompt, defaultStyle?.name]) // eslint-disable-line react-hooks/exhaustive-deps

  const setDefault = async (style: StyleRow) => {
    await fetch(`${API_URL}/api/styles/${style.id}`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ isDefault: true }) }).catch(() => {})
    load()
  }

  const clearDefault = async () => {
    if (!defaultStyle) return
    await fetch(`${API_URL}/api/styles/${defaultStyle.id}`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ isDefault: false }) }).catch(() => {})
    load()
  }

  /** Apply a preset: create-or-update a style row named after the preset. */
  const applyPreset = async (key: string) => {
    const preset = PRESETS.find((p) => p.key === key)!
    const existing = styles.find((s) => s.name.toLowerCase() === preset.name.toLowerCase())
    if (existing) {
      await fetch(`${API_URL}/api/styles/${existing.id}`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ isDefault: true }) })
    } else {
      await fetch(`${API_URL}/api/styles`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ name: preset.name, systemPrompt: preset.prompt, isDefault: true }) })
    }
    load()
  }

  const createCustom = async () => {
    if (!form.name.trim() || !form.systemPrompt.trim()) { setError('Name and style prompt are required.'); return }
    setError('')
    const res = await fetch(`${API_URL}/api/styles`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(form) })
    if (!res.ok) { setError((await res.json().catch(() => ({}))).error || 'Could not save.'); return }
    setForm({ name: '', systemPrompt: '' }); setCreating(null); load()
  }

  const analyzeSample = async () => {
    if (sample.trim().length < 100) { setError('Paste at least 100 characters of writing.'); return }
    setError(''); setSampleBusy(true)
    try {
      const res = await fetch(`${API_URL}/api/styles/from-sample`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ sample: sample.trim() }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error || 'Analysis failed.'); return }
      setForm({ name: '', systemPrompt: data.systemPrompt || '' })
      setCreating('custom')
      setSample('')
    } finally { setSampleBusy(false) }
  }

  const remove = async (id: string) => {
    await fetch(`${API_URL}/api/styles/${id}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {})
    load()
  }

  return (
    <div className="space-y-4 text-sm">
      <p className="text-slate-500">Control how the assistant writes. The active style is used in every conversation.</p>

      {/* Preset gallery */}
      <SectionHeader title="Preset styles" action={activePreset && activePreset !== 'normal' ? (
        <button onClick={clearDefault} className="text-[11px] text-slate-500 hover:text-slate-300 hover:underline">clear</button>
      ) : undefined} />
      <div className="grid grid-cols-2 gap-2">
        {PRESETS.map((p) => (
          <Card
            key={p.key}
            title={p.name}
            description={p.description}
            active={activePreset === p.key}
            onClick={() => applyPreset(p.key)}
            badge={activePreset === p.key ? <Badge tone="accent">active</Badge> : undefined}
          />
        ))}
      </div>

      {/* Your styles */}
      <SectionHeader
        title="Your styles"
        count={styles.filter((s) => !PRESETS.some((p) => p.name.toLowerCase() === s.name.toLowerCase())).length}
        action={
          <button onClick={() => setCreating(creating === 'custom' ? null : 'custom')} className="flex items-center gap-1 text-[11px] text-[#e79d7f] hover:underline">
            <PenLine size={11} /> Create your own
          </button>
        }
      />

      {creating === 'custom' && (
        <div className="p-3.5 rounded-xl border border-dashed border-white/10 space-y-2 bg-white/[0.015]">
          <input placeholder="Style name (e.g. Friendly expert)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} aria-label="Style name" />
          <textarea placeholder="How should the assistant write in this style?" rows={3} value={form.systemPrompt} onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })} className={inputCls} aria-label="Style prompt" />
          {error && <div className="text-xs text-rose-400">{error}</div>}
          <div className="flex gap-2">
            <button onClick={createCustom} className={btnPrimary}>Save style</button>
            <button onClick={() => { setCreating(null); setError('') }} className={btnGhost}>Cancel</button>
          </div>
        </div>
      )}

      {styles.filter((s) => !PRESETS.some((p) => p.name.toLowerCase() === s.name.toLowerCase())).length === 0 && creating === null && (
        <EmptyState
          icon={<Feather size={20} />}
          title="No custom styles yet"
          body="Create your own style, or generate one from a writing sample below."
        />
      )}

      {styles.filter((s) => !PRESETS.some((p) => p.name.toLowerCase() === s.name.toLowerCase())).map((s) => (
        <Card
          key={s.id}
          title={s.name}
          description={s.systemPrompt}
          badge={s.isDefault ? <Badge tone="accent">default</Badge> : undefined}
          actions={
            <>
              {!s.isDefault && (
                <button onClick={() => setDefault(s)} className="px-2.5 py-1.5 rounded-lg text-[12px] bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition">Use</button>
              )}
              <button onClick={() => remove(s.id)} className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-white/5" title="Delete style" aria-label="Delete style"><Trash2 size={14} /></button>
            </>
          }
        />
      ))}

      {/* From writing sample */}
      <SectionHeader title="Create from a writing sample" action={
        <button onClick={() => setCreating(creating === 'sample' ? null : 'sample')} className="flex items-center gap-1 text-[11px] text-[#e79d7f] hover:underline">
          <Sparkles size={11} /> {creating === 'sample' ? 'Close' : 'Try it'}
        </button>
      } />
      {creating === 'sample' && (
        <div className="p-3.5 rounded-xl border border-dashed border-white/10 space-y-2 bg-white/[0.015]">
          <textarea
            placeholder="Paste a sample of your writing (≥100 characters) — a paragraph you wrote, a favourite author's passage…"
            rows={4}
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            className={inputCls}
            aria-label="Writing sample"
          />
          <div className="flex items-center gap-2">
            <button onClick={analyzeSample} disabled={sampleBusy} className={btnPrimary}>
              {sampleBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Analyse sample
            </button>
            <span className="text-[11px] text-slate-600">Generates a style prompt you can review and save.</span>
          </div>
        </div>
      )}

      {/* Voice preferences */}
      <SectionHeader title="Voice" />
      <div className="p-3.5 rounded-xl border border-white/[0.06] bg-white/[0.02] space-y-3">
        <div className="flex items-center gap-2 text-slate-300"><Volume2 size={15} className="text-slate-500" /> Read-aloud preferences</div>
        <label className="block">
          <span className="text-xs text-slate-400">Voice</span>
          <select
            value={voiceName}
            onChange={(e) => { setVoiceName(e.target.value); saveVoicePrefs(e.target.value) }}
            className={inputCls}
            aria-label="Read-aloud voice"
          >
            <option value="" className="bg-ink-800">System default</option>
            {voices.map((v) => <option key={v.name} value={v.name} className="bg-ink-800">{v.name} ({v.lang})</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-slate-400">Playback speed — {rate.toFixed(1)}×</span>
          <input
            type="range" min="0.5" max="2" step="0.1" value={rate}
            onChange={(e) => { const r = Number(e.target.value); setRate(r); saveVoicePrefs(undefined, r) }}
            className="w-full accent-[#c96442]"
            aria-label="Playback speed"
          />
        </label>
      </div>
    </div>
  )
}
