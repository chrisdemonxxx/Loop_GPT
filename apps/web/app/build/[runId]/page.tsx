import RunView from './RunView'

/**
 * Static export can only emit params known at build time. Live builds are
 * opened from /build/?run=<id>, which this same RunView renders. `/build/_/`
 * exists so `next build` has one concrete path for this dynamic segment.
 */
export function generateStaticParams() {
  return [{ runId: '_' }]
}

export default function BuildRunPage() {
  return <RunView />
}
