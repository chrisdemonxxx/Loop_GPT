/**
 * Store vs Direct edition flavors.
 *   APP_VARIANT=store  -> com.loopgpt.app   ("Loop GPT")      — store builds
 *   APP_VARIANT=direct -> com.loopgpt.direct ("Loop GPT Direct") — sideloaded builds
 * Server-side policy/entitlement/data separation is authoritative; the client
 * variant only selects identity and naming, never authorization.
 */
export default {
  expo: {
    name: process.env.APP_VARIANT === 'direct' ? 'Loop GPT Direct' : 'Loop GPT',
    slug: 'loop-gpt',
    version: '1.0.0',
    orientation: 'portrait',
    userInterfaceStyle: 'dark',
    backgroundColor: '#111113',
    android: {
      package: process.env.APP_VARIANT === 'direct' ? 'com.loopgpt.direct' : 'com.loopgpt.app',
      adaptiveIcon: { backgroundColor: '#111113' },
    },
    ios: {
      bundleIdentifier: process.env.APP_VARIANT === 'direct' ? 'com.loopgpt.direct' : 'com.loopgpt.app',
    },
    extra: { variant: process.env.APP_VARIANT === 'direct' ? 'direct' : 'store' },
  },
}
