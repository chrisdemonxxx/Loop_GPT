/**
 * Named-bot roster. Pure data + mention routing so tests don't need a database.
 * The primary "Loop Bot" is what existing tasks fall back to. The Grok-style
 * starters ship so a new account never opens an empty Bots section.
 */

export interface StarterBot {
  name: string
  label: string
  avatarColor: string
  persona: string
  isPrimary: boolean
  defaultTools: string[]
  cloudComputer: boolean
}

export const STARTER_BOTS: StarterBot[] = [
  {
    name: 'Loop Bot',
    label: 'Primary agent',
    avatarColor: '#c96442',
    isPrimary: true,
    cloudComputer: true,
    defaultTools: ['web_search', 'web_fetch', 'create_document', 'execute_code'],
    persona: 'You are Loop Bot, the user\'s primary agent. Narrate what you are doing in short plain sentences. Never print raw JSON, tool-call tags, or status enums.',
  },
  {
    name: 'Helm',
    label: 'Coding lead',
    avatarColor: '#7c6af7',
    isPrimary: false,
    cloudComputer: true,
    defaultTools: ['create_document', 'execute_code', 'web_search'],
    persona: 'You are Helm, the coding lead. Break work into a plan, then build it. Narrate progress in words ("I\'m writing the page now. I\'ll show the preview when it renders.") and never dump tool JSON.',
  },
  {
    name: 'Review',
    label: 'Code review',
    avatarColor: '#3b82f6',
    isPrimary: false,
    cloudComputer: false,
    defaultTools: ['web_search', 'web_fetch'],
    persona: 'You are Review. Read carefully, name concrete issues, and suggest the smallest fix. Speak in complete sentences.',
  },
  {
    name: 'Builder',
    label: 'Implementation',
    avatarColor: '#22c55e',
    isPrimary: false,
    cloudComputer: true,
    defaultTools: ['create_document', 'execute_code'],
    persona: 'You are Builder. Ship working code and pages. Prefer create_document for HTML and source files. Narrate each step in words, then deliver the result.',
  },
  {
    name: 'Spec',
    label: 'Requirements',
    avatarColor: '#eab308',
    isPrimary: false,
    cloudComputer: false,
    defaultTools: ['web_search'],
    persona: 'You are Spec. Turn a request into a clear, testable specification before anyone builds it. Ask only when a missing fact would change the design.',
  },
  {
    name: 'Release',
    label: 'Ship and deploy',
    avatarColor: '#f97316',
    isPrimary: false,
    cloudComputer: true,
    defaultTools: ['create_document', 'web_search', 'web_fetch'],
    persona: 'You are Release. Check that the work is ready to ship, name what is left, and describe how to deploy it. Narrate in words.',
  },
]

export function greeting(userName: string | null | undefined, botName: string): string {
  const who = (userName || '').trim().split(/\s+/)[0] || 'there'
  return `Hi ${who}, I'm ${botName} — where do you want me to help?`
}

export interface MentionBot { id: string; name: string }

/**
 * Group routing. No @mention → every member. An @mention that matches a
 * member name (case-insensitive, prefix ok for multi-word names) → only
 * those bots. An @ that matches nobody falls back to the whole group so
 * the message is not dropped.
 */
export function botsForMessage<T extends MentionBot>(text: string, members: T[]): T[] {
  if (!members.length) return []
  const mentions = [...String(text || '').matchAll(/(^|\s)@([A-Za-z0-9][A-Za-z0-9 .'_-]{0,40})/g)]
    .map((m) => m[2].trim().toLowerCase())
    .filter(Boolean)
  if (!mentions.length) return members
  const hit = members.filter((bot) => {
    const name = bot.name.toLowerCase()
    return mentions.some((n) => name === n || name.startsWith(n) || n.startsWith(name))
  })
  return hit.length ? hit : members
}

/** One-line progress sentence for a tool step. Never a raw status enum. */
export function narrateTool(name: string, done: boolean, failed = false): string {
  const label = String(name || 'that').replace(/_/g, ' ')
  if (failed) return `I couldn't finish ${label}.`
  if (!done) {
    if (name === 'create_document') return 'I\'m writing that now. I\'ll share it as soon as it\'s ready.'
    if (name === 'web_search' || name === 'web_fetch') return 'I\'m looking that up.'
    if (name === 'generate_image') return 'I\'m generating the image.'
    if (name === 'execute_code') return 'I\'m running the code.'
    return `I'm working on ${label}.`
  }
  if (name === 'create_document') return 'The file is ready.'
  if (name === 'web_search' || name === 'web_fetch') return 'I found what I needed.'
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} is done.`
}

export function narrateSteps(steps: Array<{ tool?: string; result?: string }>): string {
  if (!steps.length) return ''
  return steps.map((s) => narrateTool(s.tool || 'that', true, /error|fail|not approved|blocked/i.test(s.result || ''))).join(' ')
}
