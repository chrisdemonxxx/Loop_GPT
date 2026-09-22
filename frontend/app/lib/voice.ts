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

  const speak = useCallback(async (id: string, text: string) => {
    if (typeof window === 'undefined') return
    // Toggle off if this message is already playing.
    if (speakingId === id) { stop(); return }
    stop()
    const clean = cleanForSpeech(text)

    // Preferred path: browser speechSynthesis.
    if (window.speechSynthesis) {
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
      return
    }

    // Fallback: backend Kokoro TTS (POST /api/tts → audio bytes) for browsers
    // without speechSynthesis (e.g. Firefox).
    try {
      const { API_URL, authHeaders } = await import('./api')
      const res = await fetch(`${API_URL}/api/tts`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: clean }),
      })
      if (!res.ok) return
      const contentType = res.headers.get('content-type') || ''
      let src: string | null = null
      if (contentType.startsWith('audio/')) {
        const blob = await res.blob()
        src = URL.createObjectURL(blob)
      } else {
        const data = await res.json().catch(() => null)
        if (data?.url) src = data.url
      }
      if (!src) return
      const audio = new Audio(src)
      audio.onended = () => { setSpeakingId(null); setPaused(false); URL.revokeObjectURL(src!) }
      audio.onerror = () => { setSpeakingId(null); setPaused(false) }
      audioRef.current = audio
      setSpeakingId(id)
      setPaused(false)
      await audio.play()
    } catch { /* silent */ }
  }, [speakingId, stop])

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
