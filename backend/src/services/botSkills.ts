/**
 * Bot skill create/update. Proxies to the account skill loader.
 * Skills stay account-level; there is no second store.
 */
import { configStore } from '../agent/configStore'
import { createUserSkill, getSkill, updateUserSkill } from '../agent/skills/skillLoader'

export interface BotSkillBody {
  name?: string
  description?: string
  instructions?: string
  triggers?: string[]
  tools?: string[]
  botId?: string
}

function enable(userId: string, id: string) {
  const set = new Set(configStore.getEnabledSkills(userId))
  set.add(id)
  configStore.setEnabledSkills(userId, [...set])
}

function view(userId: string, id: string) {
  const skill = getSkill(userId, id)
  if (!skill) return null
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    triggers: skill.triggers || [],
    tools: skill.tools || [],
  }
}

export function postBotSkill(userId: string, body: BotSkillBody): { status: number; body: Record<string, unknown> } {
  if (!body?.name || !body.instructions) return { status: 400, body: { error: 'name and instructions are required' } }
  try {
    const skill = createUserSkill({
      name: String(body.name),
      description: String(body.description || ''),
      instructions: String(body.instructions),
      triggers: body.triggers,
      tools: body.tools,
      ...(body.botId ? { botId: body.botId } : {}),
    }, userId)
    enable(userId, skill.id)
    return { status: 201, body: view(userId, skill.id) || { id: skill.id } }
  } catch {
    return { status: 400, body: { error: 'Invalid skill' } }
  }
}

export function putBotSkill(userId: string, id: string, body: BotSkillBody): { status: number; body: Record<string, unknown> } {
  if (!body?.name || !body.instructions) return { status: 400, body: { error: 'name and instructions are required' } }
  try {
    const skill = updateUserSkill(userId, id, {
      name: String(body.name),
      description: String(body.description || ''),
      instructions: String(body.instructions),
      triggers: body.triggers,
      tools: body.tools,
    })
    if (!skill) return { status: 400, body: { error: 'Built-in skills cannot be edited' } }
    enable(userId, skill.id)
    return { status: 200, body: view(userId, skill.id) || { id: skill.id } }
  } catch {
    return { status: 400, body: { error: 'Invalid skill' } }
  }
}

export function getBotSkill(userId: string, id: string): { status: number; body: Record<string, unknown> } {
  const skill = view(userId, id)
  if (!skill) return { status: 404, body: { error: 'Skill not found' } }
  return { status: 200, body: skill }
}
