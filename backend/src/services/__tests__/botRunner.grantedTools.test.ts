import { describe, expect, it } from 'vitest'
import { botRunToolCatalog, buildGrantedTools, grantedToolNamesForRun } from '../botRunner'
import { builtinTools } from '../../agent'
import { computerToolsForScreen } from '../../agent/tools/computerTools'
import type { ToolDefinition } from '../../agent/types'

function tool(name: string): ToolDefinition {
  return {
    name,
    source: 'builtin',
    description: name,
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ content: 'ok' }),
  }
}

describe('buildGrantedTools (remember_fact / skill grant)', () => {
  it('includes remember_fact after identity attachment adds it to runNames', () => {
    const catalog = [tool('web_search'), tool('remember_fact'), tool('create_document')]
    const requested = ['web_search', 'create_document']
    // attachBotIdentity merges remember_fact into names when a persona/memory exists.
    const finalNames = [...requested, 'remember_fact']
    const granted = buildGrantedTools(finalNames, catalog)
    expect(granted.map((t) => t.name).sort()).toEqual(['create_document', 'remember_fact', 'web_search'])
  })

  it('includes skill tools that attachSkill folded into runNames', () => {
    const catalog = [tool('web_search'), tool('web_fetch'), tool('remember_fact')]
    const finalNames = ['web_search', 'web_fetch', 'remember_fact']
    const granted = buildGrantedTools(finalNames, catalog)
    expect(granted.map((t) => t.name)).toContain('web_fetch')
    expect(granted.map((t) => t.name)).toContain('remember_fact')
  })

  it('deduplicates and skips unknown names', () => {
    const catalog = [tool('web_search')]
    const granted = buildGrantedTools(['web_search', 'web_search', 'not_a_tool'], catalog)
    expect(granted).toHaveLength(1)
    expect(granted[0].name).toBe('web_search')
  })

  it('grants remember_fact and computer_click and only sends granted names into restrictRunContext', () => {
    const runNames = ['remember_fact', 'computer_click', 'not_a_tool']
    const catalog = botRunToolCatalog(runNames, {
      builtins: builtinTools(),
      computerTools: computerToolsForScreen({ width: 1366, height: 768 }),
    })
    const granted = buildGrantedTools(runNames, catalog)
    const grantedNames = granted.map((entry) => entry.name)
    expect(grantedNames).toContain('remember_fact')
    expect(grantedNames).toContain('computer_click')

    const sent = grantedToolNamesForRun(runNames, granted)
    const grant = new Set(grantedNames)
    expect(sent.every((name) => grant.has(name))).toBe(true)
    expect(sent).toEqual(['remember_fact', 'computer_click'])
  })
})
