/** Slash-command registry (Claude/Linear-style palette). `mode` commands route
 * the turn (and may pin tools); `action` commands run a client-side action
 * immediately. Commands are grouped into sections for the palette. */
export type SlashKind = 'mode' | 'action'
export type SlashSection = 'Create' | 'Manage' | 'Session' | 'Help'

export interface SlashCommandDef {
  cmd: string
  label: string
  hint: string
  kind: SlashKind
  section: SlashSection
  /** For kind: 'mode', tools to pin for that turn. */
  tools?: string[]
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  // Create (generation + memory)
  { cmd: '/image', label: 'Generate an image', hint: 'Text-to-image (also /draw)', kind: 'mode', section: 'Create', tools: ['generate_image'] },
  { cmd: '/video', label: 'Generate a video', hint: 'Image-to-video from a reference', kind: 'mode', section: 'Create', tools: ['generate_video'] },
  { cmd: '/create', label: 'Create a document', hint: 'PDF, Word, Excel, slides, CSV, Markdown', kind: 'mode', section: 'Create', tools: ['create_document'] },
  { cmd: '/skills', label: 'Skills', hint: 'Browse or create a skill', kind: 'action', section: 'Create' },

  // Manage
  { cmd: '/projects', label: 'Projects', hint: 'Open or create a project', kind: 'action', section: 'Manage' },
  { cmd: '/connectors', label: 'Connectors', hint: 'Manage app connections', kind: 'action', section: 'Manage' },
  { cmd: '/plugins', label: 'Plugins', hint: 'Manage plugins', kind: 'action', section: 'Manage' },
  { cmd: '/memory', label: 'Remember this', hint: 'Store a fact for future chats', kind: 'mode', section: 'Manage', tools: ['remember'] },

  // Session
  { cmd: '/chat', label: 'Quick chat', hint: 'Fast reply, no tools', kind: 'mode', section: 'Session' },
  { cmd: '/agent', label: 'Agent', hint: 'Tool-using agent with full access', kind: 'mode', section: 'Session' },
  { cmd: '/research', label: 'Deep research', hint: 'Multi-step web research with citations', kind: 'mode', section: 'Session' },
  { cmd: '/new', label: 'New chat', hint: 'Start a fresh session', kind: 'action', section: 'Session' },
  { cmd: '/undo', label: 'Undo', hint: 'Rewind to the previous prompt', kind: 'action', section: 'Session' },
  { cmd: '/retry', label: 'Retry', hint: 'Re-run the last turn', kind: 'action', section: 'Session' },
  { cmd: '/stop', label: 'Stop', hint: 'Cancel the running answer', kind: 'action', section: 'Session' },
  { cmd: '/export', label: 'Export chat', hint: 'Download as Markdown', kind: 'action', section: 'Session' },
  { cmd: '/screenshot', label: 'Screenshot', hint: 'Capture the screen into the chat', kind: 'action', section: 'Session' },

  // Help
  { cmd: '/model', label: 'Model', hint: 'Open the model picker', kind: 'action', section: 'Help' },
  { cmd: '/settings', label: 'Settings', hint: 'Open settings', kind: 'action', section: 'Help' },
  { cmd: '/help', label: 'Shortcuts', hint: 'Show keyboard shortcuts', kind: 'action', section: 'Help' },
]

export const SLASH_SECTIONS: SlashSection[] = ['Create', 'Manage', 'Session', 'Help']

/** Subsequence fuzzy match: every char of q appears, in order, in the target. */
export function fuzzyMatch(query: string, target: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let qi = 0
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++
  }
  return qi === q.length
}

/** Filter commands for an input typed after '/': fuzzy over cmd + label. */
export function filterCommands(query: string): SlashCommandDef[] {
  const q = query.replace(/^\//, '').split(/\s+/)[0] || ''
  if (!q) return SLASH_COMMANDS
  return SLASH_COMMANDS.filter((c) => fuzzyMatch(q, c.cmd) || fuzzyMatch(q, c.label))
}

/** Map an input that begins with a slash command to a mode + tool pin. */
export function parseCommand(input: string): { mode: 'chat' | 'agent' | 'research'; text: string; tools?: string[] } {
  const m = input.match(/^\/([a-z]+)\b[ \t]*/i)
  if (m) {
    const c = m[1].toLowerCase()
    const rest = input.slice(m[0].length)
    if (c === 'research') return { mode: 'research', text: rest }
    if (c === 'chat') return { mode: 'chat', text: rest }
    if (c === 'agent') return { mode: 'agent', text: rest }
    const def = SLASH_COMMANDS.find((d) => d.cmd === `/${c}` && d.kind === 'mode' && d.tools)
    if (def) return { mode: 'agent', text: rest, tools: def.tools }
  }
  return { mode: 'agent', text: input }
}
