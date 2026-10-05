/**
 * Per-user skill ownership (teach mode foundation): taught/created skills are
 * private to the creating account, trigger matching suggests only the owner's
 * skills, and admin sees all. Uses a temp skills dir via env + dynamic import
 * (the loader reads AGENT_SKILLS_DIR at module load).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(process.platform === 'win32' ? join(tmpdir(), 'opencode') : tmpdir(), 'skills-'))
  vi.stubEnv('AGENT_SKILLS_DIR', dir)
  vi.resetModules()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

const load = async () => import('../../agent/skills/skillLoader')

describe('per-user skill ownership', () => {
  it('createUserSkill writes into the owner directory and stays invisible to others', async () => {
    const { createUserSkill, loadSkillsForUser } = await load()
    createUserSkill({ name: 'SSA Card Research', description: 'research ssa', instructions: 'do the thing', triggers: ['ssa', 'social security'] }, 'user-A')
    createUserSkill({ name: 'Other Person Skill', description: 'not yours', instructions: 'x' }, 'user-B')
    const a = loadSkillsForUser('user-A')
    expect(a.map((s) => s.name)).toEqual(['SSA Card Research'])
    expect(loadSkillsForUser('user-B').map((s) => s.name)).toEqual(['Other Person Skill'])
    expect(loadSkillsForUser('user-C')).toHaveLength(0)
  })

  it('matchSkillsForGoal suggests only the owner\'s trigger-matching skills', async () => {
    const { createUserSkill, matchSkillsForGoal } = await load()
    createUserSkill({ name: 'SSA Card Research', description: 'research', instructions: 'do it', triggers: ['ssa card', 'social security'] }, 'user-A')
    createUserSkill({ name: 'Bank Letter', description: 'letters', instructions: 'write it', triggers: ['bank letter'] }, 'user-B')
    const matches = matchSkillsForGoal('user-A', 'Research the ssa card adult application procedure')
    expect(matches.map((s) => s.name)).toEqual(['SSA Card Research'])
    expect(matchSkillsForGoal('user-A', 'bank letter')).toHaveLength(0)
  })

  it('loadAllUserSkills enumerates every owner for the admin view', async () => {
    const { createUserSkill, loadAllUserSkills } = await load()
    createUserSkill({ name: 'A Skill', description: '', instructions: 'x' }, 'user-A')
    createUserSkill({ name: 'B Skill', description: '', instructions: 'y' }, 'user-B')
    const all = loadAllUserSkills()
    expect(all.some((s) => s.ownerId === 'user-A' && s.name === 'A Skill')).toBe(true)
    expect(all.some((s) => s.ownerId === 'user-B' && s.name === 'B Skill')).toBe(true)
  })

  it('deleteUserSkillForUser only removes the owner\'s copy', async () => {
    const { createUserSkill, deleteUserSkillForUser, loadSkillsForUser } = await load()
    createUserSkill({ name: 'Shared Name', description: '', instructions: 'x' }, 'user-A')
    createUserSkill({ name: 'Shared Name', description: '', instructions: 'x' }, 'user-B')
    expect(deleteUserSkillForUser('user-A', 'shared-name')).toBe(true)
    expect(loadSkillsForUser('user-A')).toHaveLength(0)
    expect(loadSkillsForUser('user-B')).toHaveLength(1)
    expect(deleteUserSkillForUser('user-A', 'shared-name')).toBe(false)
  })
})
