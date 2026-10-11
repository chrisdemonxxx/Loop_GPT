import { beforeEach, describe, expect, it, vi } from 'vitest'

// boxFiles imports botBox for the live-box registry; botBox imports prisma.
// The jail and the parsing are the security surface here, so the box handle
// is faked and the imports are stubbed before the module loads.
vi.mock('../../services/botBox', () => ({
  getLiveUserBox: vi.fn(() => null),
}))
vi.mock('../../services/prisma', () => ({ prisma: null, hasDb: false }))
vi.mock('../../services/e2bDesktop', () => ({ buildVncUrls: vi.fn(), isE2BConfigured: () => false }))

import { BoxFilesError, jailWorkspacePath } from '../../services/boxFiles'

describe('jailWorkspacePath', () => {
  it('resolves plain relative paths against the workspace root', () => {
    expect(jailWorkspacePath('')).toBe('/workspace')
    expect(jailWorkspacePath('app/index.html')).toBe('/workspace/app/index.html')
    // Absolute paths as returned by the API resolve to themselves, not doubled.
    expect(jailWorkspacePath('/workspace/app')).toBe('/workspace/app')
  })

  it('normalises separators and dots', () => {
    expect(jailWorkspacePath('./app//styles.css')).toBe('/workspace/app/styles.css')
    expect(jailWorkspacePath('app\\win\\path.txt')).toBe('/workspace/app/win/path.txt')
  })

  it('refuses traversal out of the workspace', () => {
    for (const bad of ['../etc/passwd', 'app/../../x', '..', '/../root']) {
      expect(() => jailWorkspacePath(bad), bad).toThrow(BoxFilesError)
    }
  })

  it('refuses NUL bytes', () => {
    expect(() => jailWorkspacePath('app\0evil')).toThrow(BoxFilesError)
  })

  it('keeps the workspace root itself valid', () => {
    expect(jailWorkspacePath('/workspace')).toBe('/workspace')
  })
})
