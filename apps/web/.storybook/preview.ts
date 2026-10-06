import React from 'react'
import type { Decorator, Preview } from '@storybook/react'
// The app's own stylesheet: Tailwind base/components/utilities + the app
// tokens and the `html[data-theme='light']` override layer. Without this
// every story renders unstyled (the trap named in the kickoff preflight).
import '../app/globals.css'
// Reuse the app's real provider stack — QueryClient, ThemeProvider, I18n,
// Toast, framer-motion MotionConfig — so stories render exactly as the app
// renders, not a stripped approximation.
import { Providers } from '../app/providers'

/** A model catalog shaped like GET /api/models/catalog, so ModelSelector
 *  stories show the product's real copy instead of a fetch error. */
const CATALOG = {
  models: [
    {
      id: 'loop-auto',
      tier: 'auto',
      label: 'Loop Auto',
      description: 'Routes each turn to the best model for the job.',
      contextTokens: 200000,
    },
    {
      id: 'loop-vision',
      tier: 'vision',
      label: 'Loop Vision',
      description: 'Understands images, screenshots and PDFs.',
      contextTokens: 128000,
    },
    {
      id: 'loop-reason',
      tier: 'reasoning',
      label: 'Loop Reasoning',
      description: 'Extended thinking for hard, multi-step work.',
      contextTokens: 400000,
    },
  ],
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Deterministic fetch stub. Several components (`ModelSelector`,
 * `ArtifactsPanel`, the settings tabs, `useAuthedUrl`/`useAuthedText`) hit
 * `/api/*` on mount. In the story canvas there is no backend, so an
 * unstubbed call rejects and can surface as a console error / an error
 * state. The stub answers the catalog with real copy and everything else
 * with an empty `{}` — never a rejection.
 */
if (typeof window !== 'undefined') {
  const w = window as unknown as { __loopSbFetch?: boolean; fetch: typeof fetch }
  if (!w.__loopSbFetch) {
    w.__loopSbFetch = true
    w.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (/\/api\/models\/catalog/.test(url)) return jsonResponse(CATALOG)
      return jsonResponse({})
    }) as typeof fetch
  }
}

/**
 * Theme sync for the light/dark toolbar toggle. It sits ABOVE the app's
 * `ThemeProvider` (which owns persistence and defaults to dark) so this
 * effect runs after the provider's own mount effect — otherwise the
 * provider would wipe the attribute right after we set it.
 */
function ThemeSync({ theme, children }: { theme?: string; children: React.ReactNode }) {
  React.useEffect(() => {
    const root = document.documentElement
    if (theme === 'light') root.dataset.theme = 'light'
    else delete root.dataset.theme
  }, [theme])
  return React.createElement(React.Fragment, null, children)
}

const withProvidersAndTheme: Decorator = (Story, context) => {
  const theme = (context.globals as { theme?: string }).theme
  return React.createElement(
    ThemeSync,
    { theme },
    React.createElement(Providers, null, React.createElement(Story)),
  )
}

const preview: Preview = {
  decorators: [withProvidersAndTheme],
  globalTypes: {
    theme: {
      name: 'Theme',
      description: 'Light / dark surface (app tokens)',
      defaultValue: 'dark',
      toolbar: {
        icon: 'circlehollow',
        items: [
          { value: 'light', title: 'Light', icon: 'sun' },
          { value: 'dark', title: 'Dark', icon: 'moon' },
        ],
        dynamicTitle: true,
      },
    },
  },
  parameters: {
    layout: 'fullscreen',
    backgrounds: { disable: true },
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
  },
}

export default preview
