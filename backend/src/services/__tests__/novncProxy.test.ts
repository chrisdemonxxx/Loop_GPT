/**
 * Same-origin noVNC: the bot computer streams through OUR origin (vendored
 * /novnc client + backend websockify proxy), never E2B's hosted vnc.html —
 * the app CSP (default-src 'self', no frame-src) blocks every cross-origin
 * iframe, which is what rendered "This content is blocked".
 */
import { describe, expect, it } from 'vitest'
import { buildVncUrls } from '../e2bDesktop'
import { novncSandboxId } from '../novncProxy'

describe('buildVncUrls', () => {
  it('emits same-origin /novnc URLs that route through the websockify proxy', () => {
    const { viewUrl, interactiveUrl } = buildVncUrls('isandbox123abc', 'sekret key')
    for (const url of [viewUrl, interactiveUrl]) {
      expect(url.startsWith('/novnc/vnc.html?')).toBe(true)
      expect(url).not.toContain('e2b.app')
      expect(url).toContain(`path=${encodeURIComponent('/api/bot/novnc/isandbox123abc/websockify')}`)
      expect(url).toContain(`password=${encodeURIComponent('sekret key')}`)
      expect(url).toContain('autoconnect=true')
      expect(url).toContain('resize=scale')
    }
    expect(viewUrl).toContain('view_only=true')
    expect(interactiveUrl).toContain('view_only=false')
  })
})

describe('novncSandboxId', () => {
  it('parses the sandbox id out of the websockify path', () => {
    expect(novncSandboxId('/api/bot/novnc/iud86edlx7ekzjmut8qoz/websockify')).toBe('iud86edlx7ekzjmut8qoz')
    expect(novncSandboxId('/api/bot/novnc/iud86edlx7ekzjmut8qoz/websockify?x=1')).toBe('iud86edlx7ekzjmut8qoz')
  })

  it('rejects non-novnc paths and traversal', () => {
    expect(novncSandboxId('/api/bot/runs')).toBeNull()
    expect(novncSandboxId('/api/bot/novnc/../websockify')).toBeNull()
    expect(novncSandboxId('/api/bot/novnc/i abc/websockify')).toBeNull()
    expect(novncSandboxId(undefined)).toBeNull()
  })
})
