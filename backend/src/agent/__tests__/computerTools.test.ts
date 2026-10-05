import { describe, expect, it, vi } from 'vitest'
import { COMPUTER_TOOLS, COMPUTER_TOOL_NAMES } from '../tools/computerTools'
import type { ToolContext } from '../types'

function fakeSession(clientCalls: string[] = []) {
  const client = {
    click: vi.fn(async () => { clientCalls.push('click') }),
    moveMouse: vi.fn(async () => { clientCalls.push('move') }),
    scroll: vi.fn(async () => { clientCalls.push('scroll') }),
    drag: vi.fn(async () => { clientCalls.push('drag') }),
    typeText: vi.fn(async () => { clientCalls.push('type') }),
    press: vi.fn(async () => { clientCalls.push('press') }),
    launch: vi.fn(async () => { clientCalls.push('launch') }),
    wait: vi.fn(async () => {}),
  }
  return {
    client,
    session: {
      guard: vi.fn(async () => {}),
      screenshot: vi.fn(async () => ({ artifact: { name: 'shot.png' }, imageDataUri: 'data:image/png;base64,AA==' })),
      act: vi.fn(async (_desc: string, fn: (c: any) => Promise<void>) => {
        await fn(client)
        return { artifact: { name: 'shot.png' }, imageDataUri: 'data:image/png;base64,AA==' }
      }),
    },
  }
}

function ctxWith(session: unknown): ToolContext {
  return { userId: 'u', conversationId: 'c', emit: () => {}, scratch: session ? { computer: session } : {} }
}

const tool = (name: string) => COMPUTER_TOOLS.find((t) => t.name === name)!

describe('computer_* tools', () => {
  it('all tools fail cleanly when no session is attached', async () => {
    for (const name of COMPUTER_TOOL_NAMES) {
      const result = await tool(name).handler({ x: 1, y: 2, text: 'hi', keys: 'enter', application: 'chrome', ms: 100 }, ctxWith(null))
      expect(result.isError, name).toBe(true)
      expect(result.content).toContain('No dedicated computer')
    }
  })

  it('exposes exactly the bot-scope toolset (not the builtin registry)', () => {
    expect(COMPUTER_TOOL_NAMES).toEqual([
      'computer_screenshot', 'computer_click', 'computer_move', 'computer_scroll',
      'computer_drag', 'computer_type', 'computer_press', 'computer_launch', 'computer_wait',
    ])
  })

  it('click clamps coordinates to the real desktop and defaults to the left button', async () => {
    const { session, client } = fakeSession()
    const result = await tool('computer_click').handler({ x: -50, y: 9999 }, ctxWith(session))
    expect(result.isError).toBeUndefined()
    expect(client.click).toHaveBeenCalledWith(0, 768, 'left')
    expect(result.data.imageDataUri).toContain('data:image/png')
  })

  it('click passes the requested button through', async () => {
    const { session, client } = fakeSession()
    await tool('computer_click').handler({ x: 10, y: 20, button: 'double' }, ctxWith(session))
    expect(client.click).toHaveBeenCalledWith(10, 20, 'double')
  })

  it('press parses "ctrl+c" combos and arrays', async () => {
    const { session, client } = fakeSession()
    await tool('computer_press').handler({ keys: 'ctrl+c' }, ctxWith(session))
    expect(client.press).toHaveBeenCalledWith(['ctrl', 'c'])
    await tool('computer_press').handler({ keys: 'enter' }, ctxWith(session))
    expect(client.press).toHaveBeenCalledWith('enter')
    const bad = await tool('computer_press').handler({ keys: '' }, ctxWith(fakeSession().session))
    expect(bad.isError).toBe(true)
  })

  it('launch validates the application name', async () => {
    const { session } = fakeSession()
    const bad = await tool('computer_launch').handler({ application: 'chrome; rm -rf /' }, ctxWith(session))
    expect(bad.isError).toBe(true)
    const good = await tool('computer_launch').handler({ application: 'google-chrome' }, ctxWith(session))
    expect(good.isError).toBeUndefined()
  })

  it('type rejects empty text (whitespace is legitimate input)', async () => {
    const { session, client } = fakeSession()
    const result = await tool('computer_type').handler({ text: '' }, ctxWith(session))
    expect(result.isError).toBe(true)
    const spaces = await tool('computer_type').handler({ text: '  ' }, ctxWith(session))
    expect(spaces.isError).toBeUndefined()
    expect(client.typeText).toHaveBeenCalledWith('  ')
  })

  it('screenshot uses the session directly (guard + capture)', async () => {
    const { session } = fakeSession()
    const result = await tool('computer_screenshot').handler({}, ctxWith(session))
    expect(session.guard).toHaveBeenCalled()
    expect(session.screenshot).toHaveBeenCalled()
    expect(result.data.imageDataUri).toContain('data:image/png')
  })
})
