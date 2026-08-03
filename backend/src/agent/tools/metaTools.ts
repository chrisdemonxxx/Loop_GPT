/**
 * Meta-tools: let the agent create Skills and custom Tools directly from a chat
 * request (e.g. "make a skill that writes cold emails" or "create a tool that
 * calls my weather API"). No manual form-filling — the model calls these.
 */
import { createUserSkill } from '../skills/skillLoader'
import { customToolRegistry } from '../customTools'
import { configStore } from '../configStore'
import type { ToolDefinition } from '../types'

function asStringArray(v: any): string[] | undefined {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean)
  return undefined
}

export const createSkillTool: ToolDefinition = {
  name: 'create_skill',
  source: 'builtin',
  description:
    'Create and enable a reusable Skill for the assistant when the user asks to "make/create a skill" that does something. A skill is a named set of instructions (like a specialized persona or workflow) that auto-activates when its trigger keywords appear. Provide clear, detailed instructions.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short skill name, e.g. "Cold Email Writer".' },
      description: { type: 'string', description: 'One line describing what the skill does.' },
      instructions: { type: 'string', description: 'The full instructions/system guidance the skill injects. Be thorough and specific.' },
      triggers: { type: 'array', items: { type: 'string' }, description: 'Keywords that activate the skill (e.g. ["cold email","outreach"]). Optional; omit to always allow it.' },
    },
    required: ['name', 'instructions'],
  },
  async handler(args) {
    const name = String(args.name || '').trim()
    const instructions = String(args.instructions || '').trim()
    if (!name || !instructions) return { content: 'Error: a skill needs a name and instructions.', isError: true }
    const skill = createUserSkill({
      name,
      description: String(args.description || '').trim(),
      instructions,
      triggers: asStringArray(args.triggers),
    })
    // Enable it immediately so it takes effect.
    const set = new Set(configStore.getEnabledSkills())
    set.add(skill.id)
    configStore.setEnabledSkills(Array.from(set))
    return {
      content: `Created and enabled the skill "${skill.name}"${skill.triggers?.length ? ` (activates on: ${skill.triggers.join(', ')})` : ''}. It will apply automatically when relevant.`,
      data: { skill },
    }
  },
}

export const createCustomToolTool: ToolDefinition = {
  name: 'create_custom_tool',
  source: 'builtin',
  description:
    'Create and enable a new custom Tool/plugin that calls an HTTP API, when the user asks to "make/create a tool or plugin" for some API. The URL may contain {param} placeholders; other params become the query string (GET) or JSON body (POST). The new tool becomes callable immediately.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Tool identifier: letters, numbers, underscores only, e.g. get_weather.' },
      description: { type: 'string', description: 'What the tool does (the agent reads this to decide when to use it).' },
      method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP method.' },
      url: { type: 'string', description: 'Endpoint URL. May contain {param} placeholders, e.g. https://api.x.com/v1/{id}.' },
      headers: { type: 'object', description: 'Optional static headers, e.g. {"Authorization":"Bearer ..."}.' },
      params: {
        type: 'array',
        description: 'Parameters the tool accepts: [{name, type, description, required}].',
        items: { type: 'object' },
      },
    },
    required: ['name', 'url'],
  },
  async handler(args) {
    const name = String(args.name || '').trim()
    const url = String(args.url || '').trim()
    if (!name || !url) return { content: 'Error: a tool needs a name and a url.', isError: true }
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
      return { content: 'Error: tool name must be a valid identifier (letters, numbers, underscores; no spaces).', isError: true }
    }
    const params = Array.isArray(args.params)
      ? args.params.map((p: any) => ({
          name: String(p.name || '').trim(),
          type: p.type === 'number' || p.type === 'boolean' ? p.type : 'string',
          description: String(p.description || ''),
          required: !!p.required,
        })).filter((p: any) => p.name)
      : []
    const cfg = {
      id: `custom-${configStore.listCustomTools().length}-${name}`,
      name,
      description: String(args.description || `Custom tool ${name}`),
      method: args.method === 'GET' ? 'GET' : 'POST',
      url,
      headers: (args.headers && typeof args.headers === 'object') ? args.headers : {},
      params,
      enabled: true,
    } as const
    customToolRegistry.upsert(cfg as any)
    return { content: `Created and enabled the tool "${name}". You can call it now.`, data: { tool: { name, url, method: cfg.method } } }
  },
}
