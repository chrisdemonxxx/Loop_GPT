'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import posthog from 'posthog-js'
import * as Sentry from '@sentry/browser'

const PH_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY
const PH_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com'
const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN

let initialized = false

/** Capture a product event (no-op if PostHog isn't configured). */
export function track(event: string, props?: Record<string, any>) {
  try {
    if (PH_KEY) posthog.capture(event, props)
  } catch {
    /* ignore */
  }
}

/**
 * Initializes PostHog (product analytics / funnel) and Sentry (client error
 * monitoring) when their keys are present, and captures page views. Both are
 * completely inert without the env keys, so this is safe to ship.
 */
export default function Analytics() {
  const pathname = usePathname()

  useEffect(() => {
    if (initialized || typeof window === 'undefined') return
    initialized = true
    if (PH_KEY) {
      posthog.init(PH_KEY, { api_host: PH_HOST, capture_pageview: false, person_profiles: 'identified_only' })
    }
    if (SENTRY_DSN) {
      Sentry.init({ dsn: SENTRY_DSN, environment: process.env.NODE_ENV, tracesSampleRate: 0.1 })
    }
  }, [])

  useEffect(() => {
    if (PH_KEY && pathname) posthog.capture('$pageview', { $current_url: window.location.href, path: pathname })
  }, [pathname])

  return null
}
