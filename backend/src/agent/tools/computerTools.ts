/**
 * computer_* tools — drive a dedicated cloud desktop (E2B Desktop) attached
 * to the current bot run. Bot-scope only: these are NOT in the built-in
 * registry; the bot runner grants them explicitly when the task requests a
 * computer (task.computer.enabled). Interactive user chats never see them.
 *
 * Every action returns a fresh screenshot: data.imageDataUri is what the
 * runtime injects into the next model turn (vision), and the same frame is
 * persisted as an artifact for the run record.
 */
import type { ToolContext, ToolDefinition, ToolResult } from '../types'
import type { ComputerSession } from '../../services/computerSession'

/** Desktop geometry (E2B Desktop default 1024x768). Clicks outside this range
 *  land off-screen, so every coordinate tool clamps to it and the
 *  descriptions tell the model the truth about the canvas. */
export const COMPUTER_SCREEN_W = Math.min(Math.max(Number(process.env.COMPUTER_SCREEN_W) || 1024, 640), 3840)
export const COMPUTER_SCREEN_H = Math.min(Math.max(Number(process.env.COMPUTER_SCREEN_H) || 768, 480), 2160)

function session(ctx: ToolContext): ComputerSession | null {
  const value = ctx.scratch?.computer
  return value && typeof value.act === 'function' ? (value as ComputerSession) : null
}

function noSession(): ToolResult {
  return { content: 'No dedicated computer is attached to this run. Enable the computer session for this task first.', isError: true }
}

function clampInt(value: unknown, min: number, max: number, name: string): number {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`)
  return Math.min(Math.max(Math.round(n), min), max)
}

async function withShot(ctx: ToolContext, description: string, fn: (s: ComputerSession) => Promise<{ artifact: any; imageDataUri: string }>): Promise<ToolResult> {
  const s = session(ctx)
  if (!s) return noSession()
  const { artifact, imageDataUri } = await fn(s)
  return {
    content: `${description}. Fresh screenshot attached — read it before choosing the next action.`,
    data: { imageDataUri, artifacts: [artifact] },
  }
}

export const computerScreenshotTool: ToolDefinition = {
  name: 'computer_screenshot',
  source: 'builtin',
  description: 'Capture the current screen of the dedicated cloud computer. Always look before acting.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, ctx) => {
    const s = session(ctx)
    if (!s) return noSession()
    await s.guard()
    const { artifact, imageDataUri } = await s.screenshot()
    return { content: 'Current screen captured — read the attached screenshot.', data: { imageDataUri, artifacts: [artifact] } }
  },
}

export const computerClickTool: ToolDefinition = {
  name: 'computer_click',
  source: 'builtin',
  description: `Click the dedicated computer screen (${COMPUTER_SCREEN_W}x${COMPUTER_SCREEN_H}) at pixel coordinates (x, y). Aim for the CENTER of large targets. button: left (default), right, middle or double.`,
  parameters: {
    type: 'object',
    properties: {
      x: { type: 'number', description: `Horizontal pixel (0-${COMPUTER_SCREEN_W}).` },
      y: { type: 'number', description: `Vertical pixel (0-${COMPUTER_SCREEN_H}).` },
      button: { type: 'string', enum: ['left', 'right', 'middle', 'double'], description: 'Which click. Default left.' },
    },
    required: ['x', 'y'],
  },
  handler: async (args, ctx) => {
    const s = session(ctx)
    if (!s) return noSession()
    const x = clampInt(args.x, 0, COMPUTER_SCREEN_W, 'x')
    const y = clampInt(args.y, 0, COMPUTER_SCREEN_H, 'y')
    const button = ['left', 'right', 'middle', 'double'].includes(String(args.button)) ? String(args.button) as 'left' | 'right' | 'middle' | 'double' : 'left'
    return withShot(ctx, `${button === 'double' ? 'Double-clicked' : `${button[0].toUpperCase() + button.slice(1)}-clicked`} at (${x}, ${y})`, (ses) =>
      ses.act(`click(${x},${y})`, (client) => client.click(x, y, button)))
  },
}

export const computerMoveTool: ToolDefinition = {
  name: 'computer_move',
  source: 'builtin',
  description: 'Move the mouse pointer without clicking (hover).',
  parameters: {
    type: 'object',
    properties: {
      x: { type: 'number', description: `Horizontal pixel (0-${COMPUTER_SCREEN_W}).` },
      y: { type: 'number', description: `Vertical pixel (0-${COMPUTER_SCREEN_H}).` },
    },
    required: ['x', 'y'],
  },
  handler: async (args, ctx) => {
    const s = session(ctx)
    if (!s) return noSession()
    const x = clampInt(args.x, 0, COMPUTER_SCREEN_W, 'x')
    const y = clampInt(args.y, 0, COMPUTER_SCREEN_H, 'y')
    return withShot(ctx, `Moved the pointer to (${x}, ${y})`, (ses) => ses.act(`move(${x},${y})`, (client) => client.moveMouse(x, y)))
  },
}

export const computerScrollTool: ToolDefinition = {
  name: 'computer_scroll',
  source: 'builtin',
  description: 'Scroll the focused window up or down.',
  parameters: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction (default down).' },
      amount: { type: 'number', description: 'Wheel ticks (1-20, default 3).' },
    },
  },
  handler: async (args, ctx) => {
    const s = session(ctx)
    if (!s) return noSession()
    const direction = String(args.direction) === 'up' ? 'up' as const : 'down' as const
    const amount = clampInt(args.amount ?? 3, 1, 20, 'amount')
    return withShot(ctx, `Scrolled ${direction} by ${amount}`, (ses) => ses.act(`scroll(${direction},${amount})`, (client) => client.scroll(direction, amount)))
  },
}

export const computerDragTool: ToolDefinition = {
  name: 'computer_drag',
  source: 'builtin',
  description: 'Drag from one pixel position to another (select, move windows, reorder).',
  parameters: {
    type: 'object',
    properties: {
      from_x: { type: 'number' }, from_y: { type: 'number' },
      to_x: { type: 'number' }, to_y: { type: 'number' },
    },
    required: ['from_x', 'from_y', 'to_x', 'to_y'],
  },
  handler: async (args, ctx) => {
    const s = session(ctx)
    if (!s) return noSession()
    const from: [number, number] = [clampInt(args.from_x, 0, COMPUTER_SCREEN_W, 'from_x'), clampInt(args.from_y, 0, COMPUTER_SCREEN_H, 'from_y')]
    const to: [number, number] = [clampInt(args.to_x, 0, COMPUTER_SCREEN_W, 'to_x'), clampInt(args.to_y, 0, COMPUTER_SCREEN_H, 'to_y')]
    return withShot(ctx, `Dragged from (${from[0]}, ${from[1]}) to (${to[0]}, ${to[1]})`, (ses) => ses.act(`drag(${from}→${to})`, (client) => client.drag(from, to)))
  },
}

export const computerTypeTool: ToolDefinition = {
  name: 'computer_type',
  source: 'builtin',
  description: 'Type text at the current cursor position (as keystrokes, not paste).',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Text to type (1-2000 chars).' } },
    required: ['text'],
  },
  handler: async (args, ctx) => {
    const s = session(ctx)
    if (!s) return noSession()
    const text = String(args.text || '').slice(0, 2000)
    if (!text) return { content: 'Error: text is required.', isError: true }
    return withShot(ctx, `Typed ${text.length} character(s)`, (ses) => ses.act('type', (client) => client.typeText(text)))
  },
}

export const computerPressTool: ToolDefinition = {
  name: 'computer_press',
  source: 'builtin',
  description: 'Press a key or combo: "enter", "tab", "escape", "backspace", or combos like "ctrl+c", "ctrl+v", "alt+tab".',
  parameters: {
    type: 'object',
    properties: {
      keys: { description: 'A key name, a combo like "ctrl+enter", or an array of key names.' },
    },
    required: ['keys'],
  },
  handler: async (args, ctx) => {
    const s = session(ctx)
    if (!s) return noSession()
    let keys: string | string[]
    if (Array.isArray(args.keys)) keys = args.keys.map(String).filter(Boolean).slice(0, 6)
    else keys = String(args.keys || '').split('+').map((k) => k.trim()).filter(Boolean)
    if (!keys.length || (Array.isArray(keys) && !keys.length)) return { content: 'Error: keys is required (e.g. "enter" or "ctrl+c").', isError: true }
    const combo = Array.isArray(keys) && keys.length === 1 ? keys[0] : keys
    return withShot(ctx, `Pressed ${Array.isArray(combo) ? combo.join('+') : combo}`, (ses) => ses.act('press', (client) => client.press(combo)))
  },
}

export const computerLaunchTool: ToolDefinition = {
  name: 'computer_launch',
  source: 'builtin',
  description: 'Launch an application on the desktop (e.g. "google-chrome", "firefox", "vscode").',
  parameters: {
    type: 'object',
    properties: { application: { type: 'string', description: 'Application binary name.' } },
    required: ['application'],
  },
  handler: async (args, ctx) => {
    const s = session(ctx)
    if (!s) return noSession()
    const application = String(args.application || '').trim()
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(application)) return { content: 'Error: application must be a simple binary name (e.g. "google-chrome").', isError: true }
    const result = await withShot(ctx, `Launched ${application}`, (ses) => ses.act(`launch(${application})`, async (client) => {
      await client.launch(application)
      await client.wait(3000) // apps need a beat to open a window
    }))
    return result
  },
}

export const computerWaitTool: ToolDefinition = {
  name: 'computer_wait',
  source: 'builtin',
  description: 'Wait for the screen to settle (100-10000 ms), then look again.',
  parameters: {
    type: 'object',
    properties: { ms: { type: 'number', description: 'Milliseconds to wait (100-10000).' } },
    required: ['ms'],
  },
  handler: async (args, ctx) => {
    const s = session(ctx)
    if (!s) return noSession()
    const ms = clampInt(args.ms, 100, 10_000, 'ms')
    return withShot(ctx, `Waited ${ms}ms`, (ses) => ses.act(`wait(${ms})`, (client) => client.wait(ms)))
  },
}

export const COMPUTER_TOOLS: ToolDefinition[] = [
  computerScreenshotTool,
  computerClickTool,
  computerMoveTool,
  computerScrollTool,
  computerDragTool,
  computerTypeTool,
  computerPressTool,
  computerLaunchTool,
  computerWaitTool,
]

export const COMPUTER_TOOL_NAMES: readonly string[] = COMPUTER_TOOLS.map((t) => t.name)
