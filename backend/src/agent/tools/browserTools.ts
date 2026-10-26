/**
 * browser_* tools — drive a browser the person already paired.
 * Not in builtinTools(). A run grants them only when it asked and the named
 * device socket is live (see browserGrant.ts).
 *
 * Screenshots return data.imageDataUri. agentRuntime.ts already feeds any
 * tool result with that field into the next model turn as an image part,
 * the same path computer_* screenshots use.
 */
import type { ToolContext, ToolDefinition, ToolResult } from '../types'
import { BROWSER_TOOL_NAMES } from '../browserGrant'
import { invokeBrowserTool, type BrowserRunSource } from '../../services/browserBridge'

interface BrowserScratch {
  runId: string
  userId: string
  deviceId: string
  source?: BrowserRunSource
}

function session(ctx: ToolContext): BrowserScratch | null {
  const value = ctx.scratch?.browser
  if (!value || typeof value !== 'object') return null
  const scratch = value as BrowserScratch
  if (!scratch.runId || !scratch.userId || !scratch.deviceId) return null
  return scratch
}

function missing(): ToolResult {
  return { content: 'No paired browser is attached to this run. Use web_search.', isError: true }
}

function tool(name: (typeof BROWSER_TOOL_NAMES)[number], description: string, parameters: ToolDefinition['parameters']): ToolDefinition {
  return {
    name,
    source: 'builtin',
    description,
    parameters,
    handler: async (args, ctx) => {
      const scratch = session(ctx)
      if (!scratch) return missing()
      return invokeBrowserTool({
        userId: scratch.userId,
        deviceId: scratch.deviceId,
        runId: scratch.runId,
        source: scratch.source || 'chat',
        tool: name,
        args: args || {},
      })
    },
  }
}

const empty = { type: 'object', properties: {}, additionalProperties: false }
const intentSchema = {
  type: 'string',
  enum: ['navigate', 'read', 'submit', 'purchase', 'send', 'credential'],
  description: 'Optional action intent. Submitting forms, purchases, sending messages, or entering credentials triggers a confirmation prompt in the browser window.',
}

export function browserToolDefinitions(): ToolDefinition[] {
  return [
    tool('browser_navigate', 'Open a URL in the paired browser\'s visible Loop tab group. Refuses browser-internal pages and the Loop app itself. An .onion URL is sent only to a device that paired as Tor Browser.', {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http(s) or .onion URL.' } },
      required: ['url'],
      additionalProperties: false,
    }),
    tool('browser_snapshot', 'Read the visible text and a short accessibility outline of the current tab.', empty),
    tool('browser_screenshot', 'Capture the current tab. The image is attached for the next turn the same way a computer screenshot is.', empty),
    tool('browser_click', 'Click an element in the visible tab, by CSS selector or by viewport pixels. Risky actions (submit, purchase, send, credential) raise a confirmation in the browser window.', {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        intent: intentSchema,
      },
      additionalProperties: false,
    }),
    tool('browser_type', 'Type into the focused element, or into the element matching selector. Password fields pause for the person; risky intents raise a confirmation in the browser window.', {
      type: 'object',
      properties: {
        text: { type: 'string' },
        selector: { type: 'string' },
        intent: intentSchema,
      },
      required: ['text'],
      additionalProperties: false,
    }),
    tool('browser_key', 'Press a key in the visible tab, such as Enter, Tab, or Escape.', {
      type: 'object',
      properties: {
        key: { type: 'string' },
        intent: intentSchema,
      },
      required: ['key'],
      additionalProperties: false,
    }),
    tool('browser_scroll', 'Scroll the page or the element matching selector.', {
      type: 'object',
      properties: {
        dx: { type: 'number' },
        dy: { type: 'number' },
        selector: { type: 'string' },
      },
      additionalProperties: false,
    }),
    tool('browser_tabs', 'List, open, switch, or close tabs in the Loop tab group only.', {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'switch', 'close'] },
        tabId: { type: 'number' },
        url: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    }),
    tool('browser_wait', 'Wait for the page to settle, or for a selector to appear.', {
      type: 'object',
      properties: {
        ms: { type: 'number' },
        selector: { type: 'string' },
      },
      additionalProperties: false,
    }),
    tool('browser_console', 'Return the full console buffer for the current tab, one page at a time.', {
      type: 'object',
      properties: {
        page: { type: 'number' },
        pageSize: { type: 'number' },
      },
      additionalProperties: false,
    }),
    tool('browser_network', 'Return the full network buffer for the current tab, one page at a time. Cookie and authorization headers are already removed.', {
      type: 'object',
      properties: {
        page: { type: 'number' },
        pageSize: { type: 'number' },
      },
      additionalProperties: false,
    }),
  ]
}

export { BROWSER_TOOL_NAMES }
