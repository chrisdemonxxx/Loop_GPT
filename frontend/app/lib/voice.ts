'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/* ── Speech-to-text (dictation) — Web Speech API ──────────────────────────────
 * Live transcription into the composer with interim results, a clear
 * recording state, and graceful absence on unsupported browsers.
 * ────────────────────────────────────────────────────────────────────────── */

type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((e: any) => void) | null
  onerror: ((e: any) => void) | null
  onend: (() => void) | null
}

function getRecognition(): SpeechRecognitionLike | null {
  if (typeof window === 'undefined') return null
  const w = window as any
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition
  if (!Ctor) return null
  const rec = new Ctor()
  rec.continuous = true
  rec.interimResults = true
  return rec
}

export function useDictation({ onText, language }: { onText: (text: string, isFinal: boolean) => void; language?: string }) {
  const [supported] = useState(() => !!getRecognition())
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  const stop = useCallback(() => {
    recRef.current?.stop()
    recRef.current = null
    setRecording(false)
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }, [])

  const start = useCallback(() => {
    const rec = getRecognition()
    if (!rec) return
    rec.lang = language || (typeof navigator !== 'undefined' && navigator.language) || 'en-US'
    rec.onresult = (e: any) => {
      let interim = ''
      let final = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) final += r[0].transcript
        else interim += r[0].transcript
      }
      if (final) onTextRef.current(final, true)
      else if (interim) onTextRef.current(interim, false)
    }
    rec.onerror = () => stop()
    rec.onend = () => { if (recRef.current) { try { rec.start() } catch { stop() } } }
    recRef.current = rec
    try { rec.start() } catch { /* already started */ }
    setRecording(true)
    setElapsed(0)
    timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000)
  }, [language, stop])

  useEffect(() => () => { stop() }, [stop])

  return { supported, recording, elapsed, start, stop }
}

/* ── Text-to-speech (read aloud) — per assistant message ─────────────────────
 * Reads message content with the user's saved voice preferences (Settings →
 * Personalization → Voice). One active playback at a time; returns the id of
 * the message currently being read.
 * ────────────────────────────────────────────────────────────────────────── */

function loadVoicePrefs(): { voiceName: string; rate: number } {
  if (typeof window === 'undefined') return { voiceName: '', rate: 1 }
  try {
    return {
      voiceName: localStorage.getItem('voiceName') || '',
      rate: Number(localStorage.getItem('voiceRate')) || 1,
    }
  } catch { return { voiceName: '', rate: 1 } }
}

/** Read-aloud engine preference (§8-45): 'auto' (default) prefers the
 *  backend Kokoro voice and falls back to the browser; 'server' is
 *  Kokoro-only; 'browser' is speechSynthesis-only. */
export type TtsEngine = 'auto' | 'server' | 'browser'
const TTS_ENGINE_KEY = 'ttsEngine'

export function loadTtsEngine(): TtsEngine {
  if (typeof window === 'undefined') return 'auto'
  try {
    const v = localStorage.getItem(TTS_ENGINE_KEY)
    return v === 'server' || v === 'browser' ? v : 'auto'
  } catch { return 'auto' }
}

export function saveTtsEngine(engine: TtsEngine) {
  try { localStorage.setItem(TTS_ENGINE_KEY, engine) } catch { /* private mode */ }
}

/** The backend route's hard text cap (prisma-free contract, routes/tts.ts). */
const SERVER_TTS_MAX = 4000

export function useSpeech() {
  const [hasBrowserTts] = useState(() => typeof window !== 'undefined' && !!window.speechSynthesis)
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const stop = useCallback(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel()
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
    setSpeakingId(null)
    setPaused(false)
  }, [])

  /** Strip markdown noise for a cleaner reading experience. */
  const cleanForSpeech = (text: string) =>
    text
      .replace(/```[\s\S]*?```/g, ' (code block) ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[#*_>|]/g, '')
      .slice(0, 12000)

  /** Browser speechSynthesis playback (the historical primary path). */
  const speakWithBrowser = useCallback((id: string, clean: string) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return false
    const { voiceName, rate } = loadVoicePrefs()
    const utter = new SpeechSynthesisUtterance(clean)
    utter.rate = rate
    const voices = window.speechSynthesis.getVoices()
    const voice = voices.find((v) => v.name === voiceName)
    if (voice) utter.voice = voice
    utter.onend = () => { setSpeakingId(null); setPaused(false) }
    utter.onerror = () => { setSpeakingId(null); setPaused(false) }
    setSpeakingId(id)
    setPaused(false)
    window.speechSynthesis.speak(utter)
    return true
  }, [])

  /** Backend Kokoro playback (§8-45): POST /api/tts → audio bytes (or a
   *  provider URL). Resolves false when the server path is unavailable so
   *  the caller can fall back to the browser engine. */
  const speakWithServer = useCallback(async (id: string, clean: string): Promise<boolean> => {
    try {
      const { API_URL, authHeaders } = await import('./api')
      const res = await fetch(`${API_URL}/api/tts`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: clean.slice(0, SERVER_TTS_MAX) }),
      })
      if (!res.ok) return false
      const contentType = res.headers.get('content-type') || ''
      let src: string | null = null
      if (contentType.startsWith('audio/')) {
        const blob = await res.blob()
        src = URL.createObjectURL(blob)
      } else {
        const data = await res.json().catch(() => null)
        if (data?.url) src = data.url
      }
      if (!src) return false
      const audio = new Audio(src)
      audio.onended = () => { setSpeakingId(null); setPaused(false); URL.revokeObjectURL(src!) }
      audio.onerror = () => { setSpeakingId(null); setPaused(false); URL.revokeObjectURL(src!) }
      audioRef.current = audio
      setSpeakingId(id)
      setPaused(false)
      await audio.play()
      return true
    } catch { return false }
  }, [])

  const speak = useCallback(async (id: string, text: string) => {
    if (typeof window === 'undefined') return
    // Toggle off if this message is already playing.
    if (speakingId === id) { stop(); return }
    stop()
    const clean = cleanForSpeech(text)
    const engine = loadTtsEngine()

    // §8-45: the backend Kokoro voice is the preferred engine (quality);
    // 'browser' opts out, and 'auto' falls back to speechSynthesis when
    // the server path fails (offline, provider down, non-audio response).
    if (engine !== 'browser') {
      const played = await speakWithServer(id, clean)
      if (played) return
      if (engine === 'server') return
    }
    speakWithBrowser(id, clean)
  }, [speakingId, stop, speakWithServer, speakWithBrowser])

  const pauseOrResume = useCallback(() => {
    if (typeof window === 'undefined') return
    if (audioRef.current) {
      if (audioRef.current.paused) { audioRef.current.play(); setPaused(false) }
      else { audioRef.current.pause(); setPaused(true) }
      return
    }
    if (window.speechSynthesis) {
      if (window.speechSynthesis.paused) { window.speechSynthesis.resume(); setPaused(false) }
      else { window.speechSynthesis.pause(); setPaused(true) }
    }
  }, [])

  useEffect(() => () => {
    if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel()
    if (audioRef.current) audioRef.current.pause()
  }, [])

  // Read-aloud is always available: browser TTS or the backend fallback.
  return { supported: true, browserTts: hasBrowserTts, speakingId, paused, speak, pauseOrResume, stop }
}
