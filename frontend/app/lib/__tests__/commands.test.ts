import { describe, expect, it } from 'vitest'
import { parseCommand, SLASH_COMMANDS, filterCommands, fuzzyMatch, SLASH_SECTIONS } from '../commands'

describe('slash-command registry', () => {
  it('has the full Claude/Copilot-style command set', () => {
    const cmds = SLASH_COMMANDS.map((c) => c.cmd)
    for (const c of ['/new', '/undo', '/retry', '/stop', '/export', '/screenshot', '/model', '/settings', '/help',
      '/chat', '/agent', '/research', '/image', '/video', '/create', '/memory']) expect(cmds).toContain(c)
    expect(SLASH_COMMANDS.length).toBeGreaterThanOrEqual(16)
  })

  it('covers the extended feature surfaces (skills/projects/connectors/plugins) in sections', () => {
    const cmds = SLASH_COMMANDS.map((c) => c.cmd)
    for (const c of ['/skills', '/projects', '/connectors', '/plugins']) expect(cmds).toContain(c)
    for (const c of SLASH_COMMANDS) expect(SLASH_SECTIONS).toContain(c.section)
  })

  it('marks generation commands as mode+tools and navigation commands as action', () => {
    expect(SLASH_COMMANDS.find((c) => c.cmd === '/image')).toMatchObject({ kind: 'mode', tools: ['generate_image'] })
    expect(SLASH_COMMANDS.find((c) => c.cmd === '/create')).toMatchObject({ kind: 'mode', tools: ['create_document'] })
    expect(SLASH_COMMANDS.find((c) => c.cmd === '/new')?.kind).toBe('action')
    expect(SLASH_COMMANDS.find((c) => c.cmd === '/export')?.kind).toBe('action')
  })
})

describe('fuzzy filtering', () => {
  it('matches subsequences across cmd and label', () => {
    expect(fuzzyMatch('skl', '/skills')).toBe(true)
    expect(fuzzyMatch('prj', 'Projects')).toBe(true)
    expect(fuzzyMatch('xyz', '/settings')).toBe(false)
  })
  it('filters the command list as the user types after /', () => {
    expect(filterCommands('proj').map((c) => c.cmd)).toContain('/projects')
    expect(filterCommands('img').map((c) => c.cmd)).toContain('/image')
    expect(filterCommands('').length).toBe(SLASH_COMMANDS.length)
  })
})

describe('parseCommand', () => {
  it('defaults to agent mode', () => {
    expect(parseCommand('hello').mode).toBe('agent')
  })
  it('maps the mode commands', () => {
    expect(parseCommand('/research topic').mode).toBe('research')
    expect(parseCommand('/chat hi').mode).toBe('chat')
    expect(parseCommand('/agent do').mode).toBe('agent')
  })
  it('pins the right tools for generation commands', () => {
    expect(parseCommand('/image a cat').tools).toEqual(['generate_image'])
    expect(parseCommand('/video a dance').tools).toEqual(['generate_video'])
    expect(parseCommand('/create a report').tools).toEqual(['create_document'])
  })
  it('keeps the text after the command', () => {
    expect(parseCommand('/image a cat').text).toBe('a cat')
    expect(parseCommand('/chat hello there').text).toBe('hello there')
  })
})
