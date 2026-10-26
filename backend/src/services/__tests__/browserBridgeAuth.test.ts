import { describe, expect, it, beforeEach } from 'vitest'
import {
  armBrowserRun,
  createPairCode,
  getArmedRun,
  invokeBrowserTool,
  resetBrowserBridgeForTests,
} from '../browserBridge'

describe('browserBridge authorization and grant enforcement (Decisions 10 & 11)', () => {
  beforeEach(() => {
    resetBrowserBridgeForTests()
  })

  it('generates a pair code with expiration', () => {
    const { code, expiresAt } = createPairCode('user-1')
    expect(code).toBeTruthy()
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now())
  })

  it('refuses invokeBrowserTool if the run is not armed', async () => {
    const result = await invokeBrowserTool({
      userId: 'user-1',
      deviceId: 'dev-1',
      runId: 'run-unarmed',
      source: 'chat',
      tool: 'browser_navigate',
      args: { url: 'https://example.com' },
    })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('not authorized for this run')
  })

  it('arms a run and tracks armed state', () => {
    const armed = armBrowserRun({
      runId: 'run-100',
      userId: 'user-1',
      deviceId: 'dev-1',
      source: 'build',
    })

    expect(armed.runId).toBe('run-100')
    expect(armed.userId).toBe('user-1')
    expect(getArmedRun('run-100')).toBeDefined()
  })
})
