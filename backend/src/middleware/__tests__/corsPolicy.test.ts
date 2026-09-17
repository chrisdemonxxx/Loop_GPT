import { describe, expect, it } from 'vitest'
import { createCorsOriginPolicy } from '../corsPolicy'

describe('explicit CORS origin policy', () => {
  const allowed = createCorsOriginPolicy('https://app.example.test/, https://loop.up.railway.app')
  it('canonicalizes configured origins', () => {
    expect(allowed('https://app.example.test')).toBe(true)
    expect(allowed('https://loop.up.railway.app')).toBe(true)
  })
  it('permits absent Origin for authenticated non-browser clients', () => {
    expect(allowed(undefined)).toBe(true)
  })
  it.each(['https://attacker.up.railway.app', 'https://app.example.test.attacker.test', 'null', ''])('rejects unconfigured origin %s', (origin) => {
    expect(allowed(origin)).toBe(false)
  })
})
