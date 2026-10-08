/** HTTP failure from the Loop-IT gateway or the token mint. */
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export type ErrorKind =
  | 'network'
  | 'run_failure'
  | 'quota'
  | 'payment'
  | 'sandbox'
  | 'model'
  | 'auth'
  | 'permission'
  | 'unavailable'
  | 'unknown'

export interface UserFacingError {
  kind: ErrorKind
  title: string
  message: string
  action: string
}

/** The browser never reached the build service, or the gateway was down. */
export function isUnreachable(cause: unknown): boolean {
  if (cause instanceof ApiError) return cause.status === 0 || cause.status === 502 || cause.status === 504
  if (cause instanceof TypeError) return true
  const raw = cause instanceof Error ? cause.message : String(cause)
  return /failed to fetch|networkerror|network request failed|load failed|econnrefused/i.test(raw)
}

/** A gateway 404 (HTML or an empty "Not Found"), not a JSON 404 for one missing run. */
export function isServiceMissing(cause: unknown): boolean {
  if (!(cause instanceof ApiError)) return false
  if (cause.status === 501) return true
  if (cause.status !== 404) return false
  const msg = cause.message.trim().toLowerCase()
  return msg.length === 0 || msg === 'not found' || msg.startsWith('<!doctype') || msg.startsWith('<html')
}

export function toUserFacingError(cause: unknown): UserFacingError {
  const status = cause instanceof ApiError ? cause.status : 0
  const raw = cause instanceof Error ? cause.message : String(cause)
  const normalized = raw.toLowerCase()
  if (isUnreachable(cause)) {
    return {
      kind: 'network',
      title: 'Build service unreachable',
      message: 'The browser could not reach the build service. It may not be deployed yet.',
      action: 'Retry in a moment.',
    }
  }
  if (status === 401) return { kind: 'auth', title: 'Sign in again', message: 'Your session expired.', action: 'Sign in and retry the action.' }
  if (status === 403) return { kind: 'permission', title: 'Permission needed', message: 'Your role cannot perform this action.', action: 'Ask a workspace owner for access.' }
  if (isServiceMissing(cause)) {
    return {
      kind: 'unavailable',
      title: 'Build service unreachable',
      message: 'The build API is not reachable. It may not be deployed yet.',
      action: 'Retry in a moment.',
    }
  }
  if (status === 404) return { kind: 'unknown', title: 'Not found', message: raw || 'That resource was not found.', action: 'Return to the build list.' }
  if (status === 402 || normalized.includes('hard_quota')) return { kind: 'payment', title: 'Upgrade required', message: 'This workspace is out of included credits.', action: 'Review plans or add credits before starting another build.' }
  if (status === 429 || normalized.includes('quota') || normalized.includes('rate_limited')) return { kind: 'quota', title: 'Quota limit reached', message: 'A daily, token, sandbox, or egress limit stopped the request.', action: 'Wait for the window to reset or upgrade the plan.' }
  if (status === 503 && normalized.includes('temporal')) return { kind: 'unavailable', title: 'Run service unavailable', message: 'The durable run service is not reachable.', action: 'Retry when the operator has restored it.' }
  if (status === 503 && normalized.includes('sandbox')) return { kind: 'sandbox', title: 'Sandbox unavailable', message: 'No isolated build sandbox is available right now.', action: 'Retry shortly.' }
  if (status === 503 || normalized.includes('model')) return { kind: 'model', title: 'Model unavailable', message: 'The selected model endpoint could not accept the run.', action: 'Retry or choose a lower effort.' }
  if (status >= 500) return { kind: 'run_failure', title: 'Build failed safely', message: 'The platform hit an internal failure without exposing details.', action: 'Retry the build. If it repeats, share the run ID with support.' }
  return { kind: 'unknown', title: 'Action could not finish', message: raw || 'The build service could not complete the request.', action: 'Review your input and try again.' }
}
