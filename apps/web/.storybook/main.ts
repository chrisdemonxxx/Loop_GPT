import type { StorybookConfig } from '@storybook/nextjs'

/**
 * Loop GPT Storybook harness (UI Schema Cloning Blueprint §2/§10/§16).
 *
 * The app is a Next.js 14 static export (`next build` -> `out/`) with the
 * App Router. `@storybook/nextjs` is the framework that understands that:
 * it resolves `next/link`, the `@/*` tsconfig alias, `next/font`, and
 * imports of `'use client'` components without a Vite assumption.
 *
 * Stories are co-located with the components under `app/components/**`
 * (there is no `frontend/components/` tree on disk; the old blueprint path
 * is a stale reference — tailwind's `content` already covers `./app/**`).
 */
const config: StorybookConfig = {
  stories: [
    '../app/**/*.mdx',
    '../app/**/*.stories.@(js|jsx|mjs|ts|tsx)',
  ],
  addons: [
    '@storybook/addon-essentials',
    '@storybook/addon-interactions',
  ],
  framework: {
    name: '@storybook/nextjs',
    options: {},
  },
  // The app serves `/public` at the site root; mirror that so icons / fonts
  // referenced by the components resolve in the canvas too.
  staticDirs: ['../public'],
  docs: { autodocs: 'tag' },
  typescript: { reactDocgen: 'react-docgen-typescript' },
  // Next 14.0.4 ships an older *compiled* webpack than the top-level
  // `webpack@5` the builder uses; its filesystem `Cache.shutdown()` throws
  // ("Cannot read properties of undefined (reading 'tap')") on compiler
  // close. Force the base in-memory cache, whose hooks are always present.
  webpackFinal: async (config) => {
    config.cache = false
    return config
  },
}

export default config
