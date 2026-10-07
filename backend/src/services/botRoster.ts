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

const ALL_TAGS = new Set(['all', 'everyone'])

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Tags in the text. `tagged` is false when the user did not write an @.
 *  `all` is @all or @everyone. `hits` are full-name matches, longest name
 *  first at each @, in the order the tags appear. Keep this aligned with
 *  the copy in apps/web/app/lib/namedBots.ts. */
export function parseMentions<T extends MentionBot>(text: string, members: T[]): { tagged: boolean; all: boolean; hits: T[] } {
  const raw = String(text || '')
  if (!members.length || !/(^|\s)@\S/.test(raw)) return { tagged: false, all: false, hits: [] }
  const ordered = [...members].sort((a, b) => b.name.trim().length - a.name.trim().length)
  const seen = new Set<string>()
  const hits: T[] = []
  let all = false
  const at = /(^|\s)@/g
  let match: RegExpExecArray | null
  while ((match = at.exec(raw))) {
    const rest = raw.slice(match.index + match[1].length + 1)
    const token = (rest.split(/\s/, 1)[0] || '').replace(/[,.!?;:]+$/g, '').toLowerCase()
    if (ALL_TAGS.has(token)) { all = true; continue }
    const found = ordered.find((bot) => {
      const name = bot.name.trim()
      if (!name) return false
      return new RegExp(`^${escapeRegExp(name)}(?=$|\\s|[,.!?;:])`, 'i').test(rest)
    })
    if (found && !seen.has(found.id)) {
      seen.add(found.id)
      hits.push(found)
    }
  }
  return { tagged: true, all, hits }
}

/**
 * Group routing. No @ addresses every member. @all and @everyone do too.
 * @Name addresses only full-name matches, in mention order. More than one
 * @ in the same message all count. A tag that matches nobody adds no one,
 * and a message whose tags match nobody addresses nobody.
 */
export function botsForMessage<T extends MentionBot>(text: string, members: T[]): T[] {
  if (!members.length) return []
  const parsed = parseMentions(text, members)
  if (!parsed.tagged || parsed.all) return members
  return parsed.hits
}

/** What this bot should know about the room. One follow-up is allowed; the
 *  text tells the model not to call the whole room again. */
export function groupPreamble(selfName: string, otherNames: string[], projectInstructions?: string): string {
  const others = otherNames.map((name) => name.trim()).filter(Boolean)
  const room = others.length
    ? `You are ${selfName} in a group chat with ${others.join(', ')} and the user.`
    : `You are ${selfName} in a group chat with the user.`
  const lines = [
    room,
    'Speak only as yourself. A line that starts with a name was said by that member.',
    'Answer the user. If someone @mentioned you, answer them.',
    'If you need one other member who has not answered, mention them once as @Name.',
    'Do not repeat another member\'s answer, and do not address every member again.',
  ]
  const instructions = (projectInstructions || '').trim()
  if (instructions) lines.push(`Project instructions:\n${instructions}`)
  return lines.join('\n')
}

/** Prefix a stored group reply so the next member can tell who said it. */
export function labelSpeaker(content: string, speaker: string | null | undefined): string {
  const text = String(content || '')
  const name = (speaker || '').trim()
  if (!name) return text
  return `${name}: ${text}`
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

/** What to do when listing an owner's bots. Zero bots seed the full roster.
 *  Bots without a primary get Loop Bot back. Anything else stays as-is. */
export function rosterAction(count: number, hasPrimary: boolean): 'seed' | 'repair-primary' | 'keep' {
  if (count <= 0) return 'seed'
  if (!hasPrimary) return 'repair-primary'
  return 'keep'
}

/** The primary bot is the account's Loop Bot. Deleting it is refused. */
export function primaryDeleteRefusal(isPrimary: boolean): string | null {
  return isPrimary ? 'Loop Bot stays. It is the primary agent.' : null
}

/** A group fan-out saves the user row on the first member only. Retries
 *  re-answer the stored row and never insert another. */
export function shouldPersistUserMessage(opts: { regenerateOf?: string | null; skipUserPersist?: boolean }): boolean {
  return !opts.regenerateOf && opts.skipUserPersist !== true
}

export function narrateSteps(steps: Array<{ tool?: string; result?: string }>): string {
  if (!steps.length) return ''
  return steps.map((s) => narrateTool(s.tool || 'that', true, /error|fail|not approved|blocked/i.test(s.result || ''))).join(' ')
}
