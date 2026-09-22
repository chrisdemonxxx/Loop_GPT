import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const saved = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('../artifacts', () => ({ saveArtifact: saved.save }))

import { executeCodeTool } from '../tools/executeCode'
import type { ToolContext } from '../types'

function ctx(signal?: AbortSignal): ToolContext {
  return { userId: 'owner', conversationId: 'conversation', scratch: {}, emit: vi.fn(), signal }
}

beforeEach(() => {
  saved.save.mockReset()
  saved.save.mockImplementation(async (name: string) => ({ id: name, name, kind: 'file', url: `/api/files/${name}/content` }))
  // Force the host-subprocess sandbox (deterministic; no Docker dependency).
  vi.stubEnv('SANDBOX_DOCKER', 'false')
})
afterEach(() => vi.unstubAllEnvs())

describe('execute_code sandbox', () => {
  it('runs real JavaScript and returns its actual stdout', async () => {
    const result = await executeCodeTool.handler({
      language: 'javascript',
      code: 'const x = 6 * 7; console.log("answer=" + x);',
    }, ctx())
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('answer=42')
    expect(result.content).toContain('exit=0')
    expect(result.data.mode).toBe('subprocess')
  })

  it('reports a non-zero exit without throwing', async () => {
    const result = await executeCodeTool.handler({
      language: 'javascript',
      code: 'console.error("boom"); process.exit(3);',
    }, ctx())
    expect(result.isError).toBe(true)
    expect(result.data.exitCode).toBe(3)
    expect(result.content).toContain('boom')
  })

  it('collects files the snippet writes as downloadable artifacts', async () => {
    const result = await executeCodeTool.handler({
      language: 'javascript',
      code: 'require("fs").writeFileSync("out.txt", "hello sandbox"); console.log("wrote");',
    }, ctx())
    expect(result.isError).toBeUndefined()
    expect(saved.save).toHaveBeenCalledTimes(1)
    expect(saved.save.mock.calls[0][0]).toBe('out.txt')
    expect(result.data.artifacts).toHaveLength(1)
    expect(result.content).toContain('out.txt')
  })

  it('rejects an unsupported language and empty code', async () => {
    expect((await executeCodeTool.handler({ language: 'ruby', code: 'puts 1' }, ctx())).isError).toBe(true)
    expect((await executeCodeTool.handler({ language: 'javascript', code: '   ' }, ctx())).isError).toBe(true)
    expect(saved.save).not.toHaveBeenCalled()
  })

  it('kills runaway code at the wall-clock limit', async () => {
    const result = await executeCodeTool.handler({
      language: 'javascript',
      code: 'while (true) {}',
      timeout_seconds: 1,
    }, ctx())
    expect(result.isError).toBe(true)
    expect(result.data.timedOut).toBe(true)
  }, 15000)
})
