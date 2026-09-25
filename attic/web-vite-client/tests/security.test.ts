import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiOrigin, ClientError, filePath, readBounded, resourceId, safeFilename } from '../src/security'
import { defaultWorkspace, type Workspace } from '../src/api'
import { errorKey, locales, selectLocale, translations } from '../src/i18n'
import { Requests } from '../src/requests'

afterEach(() => vi.useRealTimers())
describe('locale/defaults', () => {
  it.each(locales)('has complete translated copy and selects exact locale %s', (locale) => {
    expect(selectLocale(locale, ['fr-FR'])).toBe(locale)
    expect(selectLocale(null, [locale.toLowerCase()])).toBe(locale)
    expect(Object.keys(translations[locale]).sort()).toEqual(Object.keys(translations['en-US']).sort())
    expect(Object.values(translations[locale]).every((value) => value.trim())).toBe(true)
  })
  it('uses language priority, supported French and a stable unsupported fallback', () => {
    expect(selectLocale('invalid', ['de-DE', 'en-IE'])).toBe('en-IE')
    expect(selectLocale(null, ['fr-FR', 'en-CA'])).toBe('fr-CA')
    expect(selectLocale(null, ['en', 'fr-CA'])).toBe('en-US')
    expect(selectLocale({}, ['de-DE'])).toBe('en-US')
    expect(selectLocale(null, [])).toBe('en-US')
    expect(translations['fr-CA'].login).not.toBe(translations['en-CA'].login)
  })
  it('prefers a writable personal workspace, then writable, then viewer, then none', () => {
    const rows: Workspace[] = [
      { id: 'read', name: 'Read', role: 'viewer', personal: false },
      { id: 'team', name: 'Team', role: 'editor', personal: false },
      { id: 'personal', name: 'Personal', role: 'owner', personal: true },
    ]
    expect(defaultWorkspace(rows)).toBe('personal')
    expect(defaultWorkspace(rows.slice(0, 2))).toBe('team')
    expect(defaultWorkspace(rows.slice(0, 1))).toBe('read')
    expect(defaultWorkspace([])).toBe('')
  })
})
describe('security boundaries', () => {
  it.each(['https://user:pass@example.com', 'http://example.com', '//attacker.invalid', 'javascript:alert(1)',
    'https://example.com/api', 'https://example.com?token=secret', 'https://example.com/#fragment', 'https://localhost.attacker.invalid/redirect'])('rejects unsafe/misconfigured origins %s', (origin) => {
    expect(() => apiOrigin(origin)).toThrow('config')
  })
  it('accepts explicit HTTPS origin and loopback-only development HTTP', () => {
    expect(apiOrigin('')).toBe('')
    expect(apiOrigin('https://api.example.com/')).toBe('https://api.example.com')
    expect(apiOrigin('http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001')
    expect(apiOrigin('http://[::1]:3001')).toBe('http://[::1]:3001')
  })
  it.each(['../secret', '%2e%2e', '//attacker.invalid', 'file?token=x', 'a\\b', '', 'a#b'])('rejects resource path injection %s', (id) => {
    expect(() => resourceId(id)).toThrow()
    expect(() => filePath(id)).toThrow()
  })
  it('normalizes traversal, controls and bidi in download names', () => {
    const filename = safeFilename('../a\\b\u202e.exe\u0000 ')
    expect(filename).not.toMatch(/[\\/\u202e\u0000]/)
    expect(filename.startsWith('.')).toBe(false)
    expect(safeFilename('...')).toBe('download')
    expect(safeFilename('x'.repeat(500))).toHaveLength(120)
  })
  it('bounds response bytes, cancels on failure and releases the stream', async () => {
    let cancelled = false
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(12)) }, cancel() { cancelled = true } })
    await expect(readBounded(new Response(stream), 10)).rejects.toThrow('tooLarge')
    expect(cancelled).toBe(true)
    expect(stream.locked).toBe(false)
  })
  it('never reflects provider/server error text in UI errors', () => {
    expect(errorKey(new Error('secret-provider-body'))).toBe('unavailable')
    expect(errorKey(new ClientError('http', 401))).toBe('expired')
    expect(errorKey(new ClientError('http', 401), true)).toBe('credentials')
    expect(errorKey(new ClientError('http', 402))).toBe('credit')
  })
  it('invalidates old callbacks synchronously while allowing later requests', () => {
    const requests = new Requests()
    const old = requests.start()
    requests.cancelAll()
    expect(old.signal.aborted).toBe(true)
    expect(old.current()).toBe(false)
    const next = requests.start()
    old.finish()
    expect(next.current()).toBe(true)
    next.finish()
    expect(next.current()).toBe(false)
  })
  it('expires hung requests without leaving timers or active tickets', () => {
    vi.useFakeTimers()
    const requests = new Requests()
    const ticket = requests.start(100)
    vi.advanceTimersByTime(101)
    expect(ticket.signal.reason.name).toBe('TimeoutError')
    expect(ticket.current()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
