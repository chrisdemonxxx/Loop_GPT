import { afterEach, describe, expect, it } from 'vitest'
import { routeMediaTurn, requestedVideoFrames } from '../modelRouter/rules'
import { routeChatTurn } from '../modelRouter/route'

const ENV_KEYS = [
  'MINIMAX_ENDPOINT_URL', 'HF_VIDEO_ENDPOINT_URL', 'VIDEO_API_URL',
  'HF_IMAGE_ENDPOINT_URL', 'HF_TOKEN', 'ROUTER_ENDPOINT_URL',
  'HF_LARGE_ENDPOINT_URL', 'HF_VISION_ENDPOINT_URL', 'HF_ENDPOINT_URL', 'HF_MODEL',
]
const saved: Record<string, string | undefined> = {}
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})
function setEnv(patch: Record<string, string | undefined>) {
  for (const key of ENV_KEYS) {
    if (!(key in saved)) saved[key] = process.env[key]
    const value = patch[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

describe('modelRouter rules — media', () => {
  it('routes text-to-video to MiniMax (t2v)', () => {
    setEnv({ MINIMAX_ENDPOINT_URL: 'https://mm.example', HF_VIDEO_ENDPOINT_URL: undefined, VIDEO_API_URL: undefined })
    const d = routeMediaTurn({ tool: 'generate_video', hasReference: false, prompt: 'a wave crashing' })
    expect(d).toMatchObject({ target: 'minimax', task: 't2v' })
    expect(d?.numFrames).toBeUndefined()
  })

  it('routes image-to-video to MiniMax (i2v)', () => {
    setEnv({ HF_VIDEO_ENDPOINT_URL: 'https://mm.example' })
    const d = routeMediaTurn({ tool: 'generate_video', hasReference: true, prompt: 'animate this' })
    expect(d).toMatchObject({ target: 'minimax', task: 'i2v' })
  })

  it('raises num_frames for explicit durations and caps at the endpoint ceiling', () => {
    setEnv({ MINIMAX_ENDPOINT_URL: 'https://mm.example' })
    const d = routeMediaTurn({ tool: 'generate_video', hasReference: false, prompt: 'a 10 seconds flythrough' })
    expect(d?.numFrames).toBe(240)
    const huge = routeMediaTurn({ tool: 'generate_video', hasReference: false, prompt: 'a 90 seconds epic' })
    expect(huge?.numFrames).toBe(241)
  })

  it('parses duration hints', () => {
    expect(requestedVideoFrames('make a 5 second clip')).toBe(120)
    expect(requestedVideoFrames('5s of rain')).toBe(120)
    expect(requestedVideoFrames('a long video about space')).toBe(121)
    expect(requestedVideoFrames('quick loop')).toBeUndefined()
  })

  it('routes image turns to the image Space when configured', () => {
    setEnv({ HF_IMAGE_ENDPOINT_URL: 'https://studio.hf.space', MINIMAX_ENDPOINT_URL: 'https://mm.example' })
    const t2i = routeMediaTurn({ tool: 'generate_image', hasReference: false, prompt: 'a cat' })
    expect(t2i).toMatchObject({ target: 'image-space', task: 't2i' })
    const i2i = routeMediaTurn({ tool: 'generate_image', hasReference: true, prompt: 'repaint this' })
    expect(i2i).toMatchObject({ target: 'image-space', task: 'i2i', faceLock: false })
  })

  it('flags face-identity intent on reference edits', () => {
    setEnv({ HF_IMAGE_ENDPOINT_URL: 'https://studio.hf.space' })
    const d = routeMediaTurn({ tool: 'generate_image', hasReference: true, prompt: 'same person, new outfit, keep the face' })
    expect(d).toMatchObject({ target: 'image-space', task: 'i2i', faceLock: true })
  })

  it('falls back to providers when no Space is configured', () => {
    setEnv({ HF_IMAGE_ENDPOINT_URL: 'https://plain-endpoint.example', HF_TOKEN: 'tok' })
    const d = routeMediaTurn({ tool: 'generate_image', hasReference: false, prompt: 'a dog' })
    expect(d?.target).toBe('flux-providers')
  })

  it('returns null when nothing is configured', () => {
    setEnv({ HF_IMAGE_ENDPOINT_URL: undefined, HF_TOKEN: undefined, MINIMAX_ENDPOINT_URL: undefined, HF_VIDEO_ENDPOINT_URL: undefined, VIDEO_API_URL: undefined })
    expect(routeMediaTurn({ tool: 'generate_image', hasReference: false, prompt: 'x' })).toBeNull()
    expect(routeMediaTurn({ tool: 'generate_video', hasReference: false, prompt: 'x' })).toBeNull()
  })
})

describe('modelRouter route — chat', () => {
  it('research mode picks a heavy tier by rule without calling the router model', async () => {
    setEnv({ ROUTER_ENDPOINT_URL: undefined, HF_LARGE_ENDPOINT_URL: 'https://large.example', HF_LARGE_MODEL: undefined })
    const d = await routeChatTurn({ prompt: 'deep dive', mode: 'research', hasImage: false, toolNames: [], contentLength: 9 })
    expect(d.decidedBy).toBe('rule')
    expect(d.target.tier).toBe('large')
  })

  it('keeps the standard default when the router model is not configured', async () => {
    setEnv({ ROUTER_ENDPOINT_URL: undefined, HF_LARGE_ENDPOINT_URL: undefined, HF_VISION_ENDPOINT_URL: undefined })
    const d = await routeChatTurn({ prompt: 'hey', mode: 'agent', hasImage: false, toolNames: [], contentLength: 3 })
    expect(d.target.tier).toBe('standard')
    expect(d.decidedBy).toBe('rule')
  })
})
