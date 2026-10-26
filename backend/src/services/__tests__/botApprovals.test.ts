import path from 'path'
import { describe, expect, it } from 'vitest'
import { approvalCategory, botToolGate, permissionOverridesForMode } from '../botApprovals'

describe('bot approvals', () => {
  it('asks for computer, terminal, and tool; auto-runs safe tools; accept-all skips the card except mandatory tools', () => {
    expect(approvalCategory('computer_click')).toBe('computer')
    expect(approvalCategory('execute_code')).toBe('terminal')
    expect(approvalCategory('connector__gh__list')).toBe('tool')

    expect(botToolGate('ask', 'computer_click')).toBe('approval')
    expect(botToolGate('ask', 'execute_code')).toBe('approval')
    expect(botToolGate('ask', 'connector__gh__list')).toBe('approval')
    expect(botToolGate('ask', 'web_search')).toBe('approval')

    expect(botToolGate('safe', 'web_search')).toBe('allow')
    expect(botToolGate('safe', 'execute_code')).toBe('approval')
    expect(botToolGate('safe', 'computer_type')).toBe('approval')

    expect(botToolGate('accept', 'execute_code')).toBe('allow')
    expect(botToolGate('accept', 'create_custom_tool')).toBe('approval')

    const overrides = permissionOverridesForMode('safe', ['web_search', 'execute_code', 'create_skill'])
    expect(overrides.web_search).toBe('allow')
    expect(overrides.execute_code).toBe('approval')
    expect(overrides.create_skill).toBe('allow')
  })

  it('resolves default data directories inside backend/data, not outside the app root', async () => {
    const servicesDir = path.resolve(__dirname, '..')
    const expectedDataDir = path.resolve(servicesDir, '../../data')
    expect(path.basename(path.dirname(expectedDataDir))).toBe('backend')
  })
})
