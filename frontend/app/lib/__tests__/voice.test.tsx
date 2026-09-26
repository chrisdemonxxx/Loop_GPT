import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { loadTtsEngine, saveTtsEngine, useSpeech } from '../voice'

/** Read-aloud engine chain (Â§8-45): the backend Kokoro voice is the primary
 *  engine; the browser's speechSynthesis is the fallback (or opt-out). */

const speakSpy = vi.fn()
const cancelSpy = vi.fn()
const audioPlaySpy = vi.fn(async () => {})
class FakeAudio {
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  paused = false
  play = audioPlaySpy
  pause = vi.fn()
}
class FakeUtterance {
  text = ''
  rate = 1
  voice: SpeechSynthesisVoice | null = null
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
}
const realCreateObjectURL = URL.createObjectURL
const realRevokeObjectURL = URL.revokeObjectURL

beforeEach(() => {
  vi.stubGlobal('speechSynthesis', {
    getVoices: () => [{ name: 'System Voice', lang: 'en-US' } as SpeechSynthesisVoice],
    speak: speakSpy, cancel: cancelSpy,
    paused: false, pause: vi.fn(), resume: vi.fn(),
  })
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance as any)
  vi.stubGlobal('Audio', FakeAudio as any)
  // jsdom has no blob-URL factory.
  ;(URL as any).createObjectURL = () => 'blob:fake-tts'
  ;(URL as any).revokeObjectURL = () => {}
  window.localStorage.clear()
  speakSpy.mockClear(); cancelSpy.mockClear(); audioPlaySpy.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  ;(URL as any).createObjectURL = realCreateObjectURL
  ;(URL as any).revokeObjectURL = realRevokeObjectURL
  window.localStorage.removeItem('ttsEngine')
})

function stubServer(ok: boolean, audio = true) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok,
    headers: { get: () => (audio ? 'audio/wav' : 'application/json') },
    blob: async () => new Blob(['wav-bytes']),
    json: async () => (audio ? null : { url: 'https://cdn.example.test/tts.mp3' }),
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('engine preference storage', () => {
  it('defaults to auto and round-trips explicit choices', () => {
    expect(loadTtsEngine()).toBe('auto')
    saveTtsEngine('server')
    expect(loadTtsEngine()).toBe('server')
    saveTtsEngine('browser')
    expect(loadTtsEngine()).toBe('browser')
  })
  it('ignores garbage values', () => {
    window.localStorage.setItem('ttsEngine', 'nonsense')
    expect(loadTtsEngine()).toBe('auto')
  })
})

describe('useSpeech engine chain (Â§8-45)', () => {
  it('prefers the server voice by default (auto) and never touches browser TTS on success', async () => {
    const fetchMock = stubServer(true)
    const { result } = renderHook(() => useSpeech())
    await act(async () => { await result.current.speak('m1', 'Hello there') })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/tts'),
      expect.objectContaining({ method: 'POST' }),
    )
    // The request body carries the text (sliced to the server's 4000 cap).
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.text).toBe('Hello there')
    expect(audioPlaySpy).toHaveBeenCalled()
    expect(result.current.speakingId).toBe('m1')
    expect(speakSpy).not.toHaveBeenCalled()
  })

  it('falls back to the browser engine when the server fails (auto mode)', async () => {
    const fetchMock = stubServer(false)
    const { result } = renderHook(() => useSpeech())
    await act(async () => { await result.current.speak('m1', 'Hello there') })
    expect(fetchMock).toHaveBeenCalled()
    await waitFor(() => expect(speakSpy).toHaveBeenCalled())
    expect(result.current.speakingId).toBe('m1')
  })

  it('server-only mode never falls back to the browser engine', async () => {
    saveTtsEngine('server')
    stubServer(false)
    const { result } = renderHook(() => useSpeech())
    await act(async () => { await result.current.speak('m1', 'Hello there') })
    expect(speakSpy).not.toHaveBeenCalled()
    expect(result.current.speakingId).toBeNull()
  })

  it('browser mode skips the server entirely', async () => {
    saveTtsEngine('browser')
    const fetchMock = stubServer(true)
    const { result } = renderHook(() => useSpeech())
    await act(async () => { await result.current.speak('m1', 'Hello there') })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(speakSpy).toHaveBeenCalled()
  })

  it('slices long text to the server contract cap', async () => {
    const fetchMock = stubServer(true)
    const { result } = renderHook(() => useSpeech())
    await act(async () => { await result.current.speak('m1', 'x'.repeat(9000)) })
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.text.length).toBeLessThanOrEqual(4000)
  })

  it('toggle: speaking the same message again stops playback', async () => {
    stubServer(true)
    const { result } = renderHook(() => useSpeech())
    await act(async () => { await result.current.speak('m1', 'Hello') })
    expect(result.current.speakingId).toBe('m1')
    await act(async () => { await result.current.speak('m1', 'Hello') })
    expect(result.current.speakingId).toBeNull()
  })
})
