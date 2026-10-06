import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

// Mock the dictation primitive: voice mode owns its own mic, and the test
// drives start/stop/recording + the transcript handler explicitly.
const dictation = vi.hoisted(() => ({
  supported: true, recording: false, elapsed: 0,
  start: vi.fn(), stop: vi.fn(),
  handler: null as null | ((text: string, isFinal: boolean) => void),
}))
vi.mock('../../lib/voice', async (original) => ({
  ...(await original<typeof import('../../lib/voice')>()),
  useDictation: (opts: { onText: (text: string, isFinal: boolean) => void }) => {
    dictation.handler = opts.onText
    return dictation
  },
  useSpeech: vi.fn(),
}))
import { useVoiceMode } from '../hooks'

/** Hands-free voice mode (§8-44): speak the finished answer, re-open the
 *  mic when the speech ends, auto-send the final transcript. */

beforeEach(() => {
  dictation.start.mockReset(); dictation.stop.mockReset()
  dictation.recording = false
  dictation.handler = null
})
afterEach(() => { dictation.handler = null })

function setup(overrides: Partial<Parameters<typeof useVoiceMode>[0]> = {}) {
  const speak = vi.fn(async () => {})
  const stopSpeech = vi.fn()
  const onAutoSend = vi.fn()
  const rendered = renderHook(
    ({ running, answer, speakingId }) => useVoiceMode({ running, answer, speakingId, speak, stopSpeech, onAutoSend, ...overrides }),
    { initialProps: { running: false, answer: '', speakingId: null as string | null } },
  )
  return { speak, stopSpeech, onAutoSend, ...rendered }
}

describe('useVoiceMode (§8-44)', () => {
  it('stays idle until activated', () => {
    const { speak } = setup()
    expect(speak).not.toHaveBeenCalled()
    expect(dictation.start).not.toHaveBeenCalled()
  })

  it('speaks the answer when a run completes while active', () => {
    const h = setup()
    act(() => h.result.current.toggle())
    expect(h.result.current.active).toBe(true)
    // A run finishes with an answer.
    h.rerender({ running: true, answer: '', speakingId: null })
    h.rerender({ running: false, answer: 'The answer is four.', speakingId: null })
    expect(h.speak).toHaveBeenCalledWith('The answer is four.')
  })

  it('re-opens the mic when the spoken answer ends', () => {
    const h = setup()
    act(() => h.result.current.toggle())
    h.rerender({ running: true, answer: '', speakingId: null })
    h.rerender({ running: false, answer: 'spoken text', speakingId: null })
    // Speech starts (the page sets speakingId via its useSpeech instance).
    h.rerender({ running: false, answer: 'spoken text', speakingId: 'voice-mode' })
    expect(dictation.start).not.toHaveBeenCalled()
    // Speech ends → the mic opens.
    h.rerender({ running: false, answer: 'spoken text', speakingId: null })
    expect(dictation.start).toHaveBeenCalled()
  })

  it('does not re-open the mic when the user manually stopped the speech', () => {
    const h = setup()
    act(() => h.result.current.toggle())
    h.rerender({ running: true, answer: '', speakingId: null })
    h.rerender({ running: false, answer: 'spoken text', speakingId: null })
    // speakingId never engaged (e.g. engine failed) → no listen.
    expect(dictation.start).not.toHaveBeenCalled()
  })

  it('deactivating stops the mic and the speech', () => {
    const h = setup()
    act(() => h.result.current.toggle())
    expect(h.result.current.active).toBe(true)
    act(() => h.result.current.toggle())
    expect(h.result.current.active).toBe(false)
    expect(dictation.stop).toHaveBeenCalled()
    expect(h.stopSpeech).toHaveBeenCalled()
  })

  it('a completed run while inactive never speaks', () => {
    const h = setup()
    h.rerender({ running: true, answer: '', speakingId: null })
    h.rerender({ running: false, answer: 'text', speakingId: null })
    expect(h.speak).not.toHaveBeenCalled()
  })

  it('auto-sends a final transcript, but never an interim one', () => {
    const h = setup()
    act(() => h.result.current.toggle())
    act(() => dictation.handler?.('hello the', false))
    expect(h.onAutoSend).not.toHaveBeenCalled()
    act(() => dictation.handler?.('hello there', true))
    expect(h.onAutoSend).toHaveBeenCalledWith('hello there')
  })

  it('never auto-sends while a run is still in flight', () => {
    const h = setup()
    act(() => h.result.current.toggle())
    h.rerender({ running: true, answer: '', speakingId: null })
    act(() => dictation.handler?.('hello there', true))
    expect(h.onAutoSend).not.toHaveBeenCalled()
  })
})
