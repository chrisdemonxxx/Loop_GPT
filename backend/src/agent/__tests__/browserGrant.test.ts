import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { builtinTools } from '../index'
import { streamInput } from '../../controllers/agentStream'
import { redactPayload } from '../../services/browserRedact'
import {
  BROWSER_ONION_MESSAGE,
  BROWSER_TOOL_NAMES,
  applyWebSearchToggle,
  evaluateBrowserCall,
  shouldDetachAfterCall,
  withBrowserGrant,
} from '../browserGrant'

const selectable = ['web_search', 'web_fetch', 'read_file']

describe('browser tool grant', () => {
  it('does not put browser tools in the default builtin list', () => {
    const names = builtinTools().map((tool) => tool.name)
    expect(names).not.toContain('browser_navigate')
    for (const name of BROWSER_TOOL_NAMES) expect(names).not.toContain(name)
  })

  it('lets web search add or remove only web tools', () => {
    const withBrowser = ['read_file', 'browser_navigate', 'web_search']
    expect(applyWebSearchToggle(withBrowser, false, selectable)).toEqual(['read_file', 'browser_navigate'])
    expect(applyWebSearchToggle(['read_file', 'browser_click'], true, selectable)).toEqual([
      'read_file',
      'browser_click',
      'web_search',
      'web_fetch',
    ])
  })

  it('grants browser tools only for a live non-chat turn', () => {
    const selected = ['web_search', 'browser_navigate']
    expect(withBrowserGrant(selected, { mode: 'chat', browser: true, deviceLive: true })).toEqual(['web_search'])
    expect(withBrowserGrant(selected, { mode: 'agent', browser: true, deviceLive: false })).toEqual(['web_search'])
    expect(withBrowserGrant(selected, { mode: 'agent', browser: false, deviceLive: true })).toEqual(['web_search'])
    const granted = withBrowserGrant(selected, { mode: 'agent', browser: true, deviceLive: true })
    expect(granted).toEqual(expect.arrayContaining([...BROWSER_TOOL_NAMES]))
    expect(granted.filter((name) => name === 'browser_navigate')).toHaveLength(1)
  })

  it('parses the stream body fields and refuses a bad device id', () => {
    const parsed = streamInput.parse({ content: 'hi', browser: true, browserDeviceId: 'brw_device_1' })
    expect(parsed.browser).toBe(true)
    expect(parsed.browserDeviceId).toBe('brw_device_1')
    expect(streamInput.safeParse({ browser: true, browserDeviceId: 'has space' }).success).toBe(false)
  })

  it('sends an onion URL only toward a Tor Browser device', () => {
    const args = { url: 'http://example.onion/path' }
    expect(evaluateBrowserCall({
      revoked: false, live: true, family: 'chromium', tool: 'browser_navigate', args,
    })).toEqual({ forward: false, message: BROWSER_ONION_MESSAGE })
    expect(evaluateBrowserCall({
      revoked: false, live: true, family: 'firefox', tool: 'browser_navigate', args,
    }).forward).toBe(false)
    expect(evaluateBrowserCall({
      revoked: false, live: true, family: 'tor', tool: 'browser_navigate', args,
    })).toEqual({ forward: true })
  })

  it('finishes the in-flight call before detaching a revoked run', () => {
    expect(shouldDetachAfterCall(1, true)).toBe(false)
    expect(shouldDetachAfterCall(0, true)).toBe(true)
    expect(shouldDetachAfterCall(0, false)).toBe(false)
  })

  it('redacts the same cookie and password fields the extension drops', async () => {
    const sample = {
      cookie: 'session=1',
      headers: [
        { name: 'Cookie', value: 'a=b' },
        { name: 'Authorization', value: 'Bearer x' },
        { name: 'Accept', value: 'text/html' },
      ],
      body: { password: 'hunter2', session_token: 'abc', note: 'keep' },
    }
    const file = pathToFileURL(path.resolve(__dirname, '../../../../packages/browser-extension/src/redact.js'))
    const extension = await import(file.href) as { redactPayload: (value: unknown) => unknown }
    expect(extension.redactPayload(sample)).toEqual(redactPayload(sample))
    const redacted = redactPayload(sample) as { headers: Array<{ name: string }>; body: { note: string } }
    expect(redacted.headers.map((header) => header.name)).toEqual(['Accept'])
    expect(JSON.stringify(redacted)).not.toContain('hunter2')
    expect(redacted.body.note).toBe('keep')
  })
})
