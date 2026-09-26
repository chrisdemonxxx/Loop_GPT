import { describe, expect, it } from 'vitest'
import { buildBranchView } from '../branch'
import type { Message } from '../../components/chat/types'

/** Branch-view derivation (audit §8-22): the active path + <2/3> version
 * groups computed from the full row set. */

const t0 = '2026-09-26T10:00:00.000Z'
const t = (n: number) => new Date(new Date(t0).getTime() + n * 1000).toISOString()
const m = (id: string, over: Partial<Message> = {}): Message => ({
  id, role: 'assistant', content: `content-${id}`, createdAt: t(0), ...over,
})

describe('buildBranchView (§8-22)', () => {
  it('walks the active path from the leaf and excludes off-path versions', () => {
    const rows: Message[] = [
      m('u1', { role: 'user', parentId: null }),
      m('a1', { parentId: 'u1' }),
      m('u2', { role: 'user', parentId: 'a1' }),
      m('a2', { parentId: 'u2' }),
      m('a2b', { parentId: 'u2', createdAt: t(5) }), // retry of a2
    ]
    const view = buildBranchView(rows, 'a2b')
    expect(view.path.map((r) => r.id)).toEqual(['u1', 'a1', 'u2', 'a2b'])
    // The old answer still exists — it is what the arrows flip back to.
    expect(view.versions['a2b']).toMatchObject({ index: 2, count: 2 })
    expect(view.versions['a2b']?.prev?.id).toBe('a2')
    expect(view.versions['u1']).toBeUndefined() // singleton: no arrows
  })

  it('groups root-sibling edits (parentId null) into one version set', () => {
    const rows: Message[] = [
      m('u1', { role: 'user', parentId: null, createdAt: t(1) }),
      m('a1', { parentId: 'u1' }),
      m('u2', { role: 'user', parentId: null, createdAt: t(9) }), // edited first prompt
      m('a2', { parentId: 'u2' }),
    ]
    const view = buildBranchView(rows, 'a2')
    expect(view.path.map((r) => r.id)).toEqual(['u2', 'a2'])
    expect(view.versions['u2']).toMatchObject({ index: 2, count: 2 })
    expect(view.versions['u2']?.prev?.id).toBe('u1')
  })

  it('falls back to flat chronology when no tree info is served', () => {
    const rows: Message[] = [
      m('u1', { role: 'user' }),
      m('a1', {}),
    ]
    const view = buildBranchView(rows, null)
    expect(view.path.map((r) => r.id)).toEqual(['u1', 'a1'])
    expect(view.versions).toEqual({})
  })

  it('falls back to chronology when the active leaf is not in the row set', () => {
    const rows: Message[] = [
      m('u1', { role: 'user', parentId: null, createdAt: t(1) }),
      m('a1', { parentId: 'u1', createdAt: t(2) }),
    ]
    const view = buildBranchView(rows, 'missing-leaf')
    expect(view.path.map((r) => r.id)).toEqual(['u1', 'a1'])
  })

  it('guards against corrupt parent cycles', () => {
    const rows: Message[] = [
      m('x', { parentId: 'y' }),
      m('y', { parentId: 'x' }),
    ]
    const view = buildBranchView(rows, 'x')
    // The walk terminates (the seen-set breaks the loop) and the leaf is
    // included — exact ordering inside a corrupt cycle is not meaningful.
    expect(view.path.map((r) => r.id)).toContain('x')
    expect(view.path.map((r) => r.id).length).toBeLessThanOrEqual(2)
  })

  it('orders siblings by creation time so arrow order matches history', () => {
    const rows: Message[] = [
      m('a-new', { parentId: 'u', createdAt: t(9) }),
      m('a-old', { parentId: 'u', createdAt: t(3) }),
    ]
    const view = buildBranchView(rows, 'a-new')
    expect(view.versions['a-new']).toMatchObject({ index: 2, count: 2 })
    expect(view.versions['a-new']?.prev?.id).toBe('a-old')
  })
})
