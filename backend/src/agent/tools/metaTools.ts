/**
 * Meta-tools: let the agent create Skills and custom Tools directly from a chat
 * request (e.g. "make a skill that writes cold emails" or "create a tool that
 * calls my weather API"). No manual form-filling — the model calls these.
 * Everything they create belongs to the account running the conversation.
 */
import { randomUUID } from 'crypto'
import { createUserSkill } from '../skills/skillLoader'
import { buildCustomTool, customToolRegistry, CustomToolError } from '../customTools'
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
  async handler(args, ctx) {
    const name = String(args.name || '').trim()
    const instructions = String(args.instructions || '').trim()
    if (!name || !instructions) return { content: 'Error: a skill needs a name and instructions.', isError: true }
    if (!ctx?.userId) return { content: 'Error: skills can only be created inside a signed-in conversation.', isError: true }
    // Owner-scoped write: the skill belongs to the account that created it
    // (teach mode + chat both run as the user), so taught skills stay private.
    const skill = createUserSkill({
      name,
      description: String(args.description || '').trim(),
      instructions,
      triggers: asStringArray(args.triggers),
      botId: typeof ctx?.scratch?.botId === 'string' ? ctx.scratch.botId : undefined,
    }, ctx.userId)
    // Enable it immediately (for this user only) so it takes effect.
    configStore.setEnabledSkills(ctx.userId, [...configStore.getEnabledSkills(ctx.userId), skill.id])
    return {
      content: `Created and enabled the skill "${skill.name}"${skill.triggers?.length ? ` (activates on: ${skill.triggers.join(', ')})` : ''}. It will apply automatically when relevant.`,
      data: { skill },
    }
  },
}

export const createCustomToolTool: ToolDefinition = {
  name: 'create_custom_tool',
  source: 'builtin',
  // Persisting a credential-bearing outbound integration always needs an
  // explicit user decision (agentRuntime enforces this even in auto-approve).
  needsApproval: true,
  description:
    'Create and enable a new custom Tool/plugin that calls an HTTP API, when the user asks to "make/create a tool or plugin" for some API. The URL may contain {param} placeholders in its path or query; other params become the query string (GET) or JSON body (POST). The user must approve the creation; the new tool is available from the next message.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Tool identifier: letters, numbers, underscores only, e.g. get_weather.' },
      description: { type: 'string', description: 'What the tool does (the agent reads this to decide when to use it).' },
      method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP method.' },
      url: { type: 'string', description: 'Public endpoint URL. May contain {param} placeholders in the path or query, e.g. https://api.x.com/v1/{id}.' },
      headers: { type: 'object', description: 'Optional static headers, e.g. {"Authorization":"Bearer ..."}.' },
      params: {
        type: 'array',
        description: 'Parameters the tool accepts: [{name, type, description, required}].',
        items: { type: 'object' },
      },
    },
    required: ['name', 'url'],
  },
  async handler(args, ctx) {
    if (!ctx?.userId) return { content: 'Error: tools can only be created inside a signed-in conversation.', isError: true }
    try {
      const cfg = buildCustomTool(ctx.userId, {
        id: `custom-${randomUUID().slice(0, 8)}`,
        name: args.name, description: args.description, method: args.method,
        url: args.url, headers: args.headers, params: args.params,
      })
      customToolRegistry.upsert(ctx.userId, cfg)
      return { content: `Created and enabled the tool "${cfg.name}". It is available from your next message.`, data: { tool: { name: cfg.name, url: cfg.url, method: cfg.method } } }
    } catch (error) {
      return { content: `Error: ${error instanceof CustomToolError ? error.message : 'could not create the tool.'}`, isError: true }
    }
  },
}
