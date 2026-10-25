import { beforeEach, describe, expect, it, vi } from 'vitest'

const connect = vi.fn()
const attachUserBoxFromDB = vi.fn(async () => 'sbx-test')
const remainingVmMinutes = vi.fn(async () => 30)

// boxFiles imports botBox for the live-box registry; botBox imports prisma.
// The jail and the parsing are the security surface here, so the box handle
// is faked and the imports are stubbed before the module loads.
vi.mock('../../services/botBox', () => ({
  getLiveUserBox: vi.fn(() => null),
  attachUserBoxFromDB: (...args: unknown[]) => attachUserBoxFromDB(...args),
}))
vi.mock('../../services/agentTasks', () => ({
  remainingVmMinutes: (...args: unknown[]) => remainingVmMinutes(...args),
  AgentTaskError: class AgentTaskError extends Error {
    code: string
    constructor(code: string, detail?: string) {
      super(detail || code)
      this.code = code
    }
  },
}))
vi.mock('../../services/prisma', () => ({ prisma: null, hasDb: false }))
vi.mock('../../services/e2bDesktop', () => ({ buildVncUrls: vi.fn(), isE2BConfigured: () => false }))
vi.mock('@e2b/desktop', () => ({
  Sandbox: { connect: (...args: unknown[]) => connect(...args) },
}))

import { AgentTaskError } from '../../services/agentTasks'
import { BoxFilesError, boxFileHttpStatus, jailWorkspacePath, listBoxFiles, deleteBoxPath, readBoxFile } from '../../services/boxFiles'

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

describe('boxFiles CommandExitError handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    attachUserBoxFromDB.mockResolvedValue('sbx-test')
    remainingVmMinutes.mockResolvedValue(30)
  })

  it('treats exit-1 CommandExitError as false for existence checks (not_found on delete)', async () => {
    class CommandExitError extends Error {
      exitCode = 1
      stdout = ''
      stderr = ''
    }
    const run = vi.fn(async (cmd: string) => {
      if (cmd.startsWith('realpath')) return { stdout: '/workspace/missing.txt\n', exitCode: 0 }
      if (cmd.startsWith('test -e')) throw new CommandExitError('exit 1')
      return { stdout: '', exitCode: 0 }
    })
    connect.mockResolvedValue({ commands: { run } })
    await expect(deleteBoxPath('user-1', 'missing.txt')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('sorts list results in JS (dirs first)', async () => {
    const run = vi.fn(async (cmd: string) => {
      if (cmd.startsWith('realpath')) return { stdout: '/workspace\n', exitCode: 0 }
      if (cmd.startsWith('find')) {
        return {
          stdout: 'f\t10\t/workspace/b.txt\nd\t0\t/workspace/a-dir\nf\t2\t/workspace/a.txt\n',
          exitCode: 0,
        }
      }
      return { stdout: '', exitCode: 0 }
    })
    connect.mockResolvedValue({ commands: { run } })
    const entries = await listBoxFiles('user-1', '/workspace')
    expect(entries.map((e) => e.name)).toEqual(['a-dir', 'a.txt', 'b.txt'])
  })

  it('refuses realpath escapes outside /workspace', async () => {
    const run = vi.fn(async (cmd: string) => {
      if (cmd.startsWith('realpath')) return { stdout: '/etc/passwd\n', exitCode: 0 }
      return { stdout: '', exitCode: 0 }
    })
    connect.mockResolvedValue({ commands: { run } })
    await expect(readBoxFile('user-1', 'link')).rejects.toMatchObject({ code: 'bad_path' })
  })

  it('does not resume a paused box when the VM-minute quota is spent', async () => {
    remainingVmMinutes.mockRejectedValue(new AgentTaskError('quota'))
    await expect(listBoxFiles('user-1', '/workspace')).rejects.toMatchObject({ code: 'quota' })
    expect(connect).not.toHaveBeenCalled()
  })

  it('surfaces a connect failure as io with the provider message', async () => {
    connect.mockRejectedValue(new Error('sandbox timeout'))
    await expect(listBoxFiles('user-1', '/workspace')).rejects.toMatchObject({
      code: 'io',
      message: 'sandbox timeout',
    })
  })
})

describe('boxFileHttpStatus', () => {
  it('maps io to 503 and a missing path to 404', () => {
    expect(boxFileHttpStatus('io')).toBe(503)
    expect(boxFileHttpStatus('not_found')).toBe(404)
    expect(boxFileHttpStatus('no_box')).toBe(409)
  })
})
