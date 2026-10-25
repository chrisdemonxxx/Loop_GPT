import { describe, expect, it } from 'vitest'
import { publicSharePath } from '../conversations'

describe('publicSharePath', () => {
  it('uses the query token the static /share/ page reads', () => {
    expect(publicSharePath('abc123')).toBe('/share/?token=abc123')
    expect(publicSharePath('abc123')).not.toBe('/share/abc123')
  })
})
