/**
 * Skill loader.
 *
 * Built-in skills are compiled data (builtin.ts). User skills can be dropped
 * into backend/skills/<id>/SKILL.md with YAML-ish frontmatter:
 *
 *   ---
 *   name: My Skill
 *   description: what it does
 *   triggers: keyword1, keyword2
 *   tools: create_document
 *   ---
 *   <instructions...>
 */
import fs from 'fs'
import path from 'path'
import { BUILTIN_SKILLS } from './builtin'
import { configStore } from '../configStore'

export interface Skill {
  id: string
  name: string
  description: string
  instructions: string
  triggers?: string[]
  tools?: string[]
  builtin?: boolean
}

// User skills live in the writable data dir (alongside the config store), so
// they work in containers where the app cwd is read-only. Override with
// AGENT_SKILLS_DIR.
const DATA_DIR = process.env.AGENT_DATA_DIR || path.join(__dirname, '../../../data')
const USER_SKILL_DIR = process.env.AGENT_SKILLS_DIR || path.join(DATA_DIR, 'skills')

function parseSkillMd(dir: string, id: string): Skill | null {
  try {
    const file = path.join(dir, 'SKILL.md')
    if (!fs.existsSync(file)) return null
    const raw = fs.readFileSync(file, 'utf-8')
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
    const meta: Record<string, string> = {}
    let body = raw
    if (fm) {
      body = fm[2]
      for (const line of fm[1].split('\n')) {
        const idx = line.indexOf(':')
        if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
      }
    }
    return {
      id,
      name: meta.name || id,
      description: meta.description || '',
      instructions: body.trim(),
      triggers: meta.triggers ? meta.triggers.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : undefined,
      tools: meta.tools ? meta.tools.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    }
  } catch {
    return null
  }
}

export function loadUserSkills(): Skill[] {
  const out: Skill[] = []
  try {
    if (!fs.existsSync(USER_SKILL_DIR)) return out
    for (const entry of fs.readdirSync(USER_SKILL_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const skill = parseSkillMd(path.join(USER_SKILL_DIR, entry.name), entry.name)
        if (skill) out.push(skill)
      }
    }
  } catch {
    /* ignore */
  }
  return out
}

export function getAllSkills(): Skill[] {
  return [...BUILTIN_SKILLS.map((s) => ({ ...s, builtin: true })), ...loadUserSkills()]
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || `skill-${Date.now()}`
}

/** Create (or overwrite) a user skill by writing skills/<id>/SKILL.md. */
export function createUserSkill(input: {
  id?: string
  name: string
  description: string
  instructions: string
  triggers?: string[]
  tools?: string[]
}): Skill {
  const id = input.id || slugify(input.name)
  const dir = path.join(USER_SKILL_DIR, id)
  fs.mkdirSync(dir, { recursive: true })
  const fm = [
    '---',
    `name: ${input.name}`,
    `description: ${input.description}`,
    input.triggers?.length ? `triggers: ${input.triggers.join(', ')}` : '',
    input.tools?.length ? `tools: ${input.tools.join(', ')}` : '',
    '---',
    '',
    input.instructions.trim(),
    '',
  ].filter((l) => l !== '').join('\n')
  fs.writeFileSync(path.join(dir, 'SKILL.md'), fm)
  return { id, name: input.name, description: input.description, instructions: input.instructions, triggers: input.triggers, tools: input.tools }
}

/** Delete a user skill directory. Built-in skills cannot be deleted. */
export function deleteUserSkill(id: string): boolean {
  const dir = path.join(USER_SKILL_DIR, id)
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  }
  return false
}

export function getSkill(id: string): Skill | undefined {
  return getAllSkills().find((s) => s.id === id)
}

/** Raw SKILL.md source for a user skill (frontmatter + instructions), for the
 * Settings "Edit source" view. Built-ins return their composed equivalent. */
export function getSkillSource(id: string): string | null {
  const skill = getSkill(id)
  if (!skill) return null
  if (!skill.builtin) {
    try {
      const file = path.join(USER_SKILL_DIR, id, 'SKILL.md')
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf-8')
    } catch { /* fall through to composed */ }
  }
  const fm = [
    '---',
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    skill.triggers?.length ? `triggers: ${skill.triggers.join(', ')}` : '',
    skill.tools?.length ? `tools: ${skill.tools.join(', ')}` : '',
    '---',
    '',
    skill.instructions,
    '',
  ].filter((l) => l !== '').join('\n')
  return fm
}

/** Update (or create) a user skill by id, writing SKILL.md. */
export function updateUserSkill(id: string, input: {
  name: string
  description: string
  instructions: string
  triggers?: string[]
  tools?: string[]
}): Skill | null {
  if (BUILTIN_SKILLS.some((s) => s.id === id)) return null
  const safeId = id.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 48)
  if (!safeId) return null
  const skill = createUserSkill({ id: safeId, ...input })
  return skill
}

/**
 * For a given user query, return the enabled skills that should be injected
 * (those whose triggers match the query, plus trigger-less enabled skills),
 * along with the union of tool names they recommend.
 */
export function getActiveSkills(query: string): { skills: Skill[]; toolNames: string[] } {
  const enabled = new Set(configStore.getEnabledSkills())
  const q = (query || '').toLowerCase()
  const active = getAllSkills().filter((s) => {
    if (!enabled.has(s.id)) return false
    if (!s.triggers || s.triggers.length === 0) return true
    return s.triggers.some((t) => q.includes(t))
  })
  const toolNames = Array.from(new Set(active.flatMap((s) => s.tools || [])))
  return { skills: active, toolNames }
}

/** Compose the skill instructions into a system-prompt fragment. */
export function buildSkillPrompt(skills: Skill[]): string {
  if (skills.length === 0) return ''
  return [
    'The following skills are active for this request. Follow their guidance:',
    ...skills.map((s) => `\n## Skill: ${s.name}\n${s.instructions}`),
  ].join('\n')
}
