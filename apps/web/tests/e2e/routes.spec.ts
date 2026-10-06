import { test, expect } from '@playwright/test'

/**
 * Route table (blueprint §13.2 / §4): every app route answers 200 with
 * HTML (content-type asserted — the §6.2 probe hazard: a wrong answer can
 * be an index.html fallback with a 200), and the §4.3 confirmed non-routes
 * answer a REAL 404. Path-param detail routes follow this app's established
 * query-param adaptation (documented in the contracts).
 */
const APP_ROUTES = [
  '/', '/new', '/chat/', '/recents/', '/projects/', '/project', '/artifacts/', '/artifact/',
  '/customize/', '/customize/connectors/all',
  '/downloads', '/upgrade', '/buying-specialist',
  '/code', '/code/artifacts', '/code/customize',
  '/login/', '/signup/', '/forgot/', '/reset/', '/verify/', '/onboarding/',
  '/account/', '/admin/', '/developer/', '/share/',
  '/privacy', '/terms', '/cookies', '/acceptable-use',
]

const NOT_ROUTES = ['/usage', '/tasks', '/upgrade/team', '/upgrade/enterprise', '/cowork']

test.describe('route table (§4)', () => {
  for (const route of APP_ROUTES) {
    test(`${route} answers 200 with HTML`, async ({ request }) => {
      const res = await request.get(route)
      expect(res.status(), `expected 200 for ${route}`).toBe(200)
      expect(res.headers()['content-type'], `content-type for ${route} must be HTML — anything else is a fallback hazard (§6.2)`).toContain('text/html')
      // Every app page embeds Next's serialized notFound template in its
      // flight data, so "This page could not be found" appears everywhere.
      // The real 404 page — and only it — carries the `<title>404:` head tag.
      const body = await res.text()
      expect(body, `${route} must not serve the 404 page`).not.toContain('<title>404:')
    })
  }

  for (const route of NOT_ROUTES) {
    test(`${route} is a real 404 (§4.3)`, async ({ request }) => {
      const res = await request.get(route)
      expect(res.status(), `expected 404 for ${route}`).toBe(404)
      expect(res.headers()['content-type']).toContain('text/html')
      const body = await res.text()
      expect(body).toContain('<title>404:')
    })
  }

  test('settings hash deep link stays on the chat shell with 200', async ({ request }) => {
    const res = await request.get('/chat/#settings/account')
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('text/html')
  })
})