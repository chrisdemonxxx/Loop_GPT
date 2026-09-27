/**
 * The served-revision instrument.
 *
 * The deploy gate could not be measured: `/api/version` was 404 on both origins,
 * and `/healthz` is a static nginx string, so "live == HEAD" was unprovable
 * (team/PHASES.md, P1 decider gate). This answers it in one unauthenticated,
 * uncached GET.
 *
 * The revision is read from the platform env at process start — on Railway the
 * commit SHA is already in `RAILWAY_GIT_COMMIT_SHA`, so the value is the
 * *served* build, not the local checkout. `GIT_REVISION`/`GIT_SHA` are the
 * explicit overrides for any other host; a build may also bake
 * `BUILD_REVISION` into the image. When none is present the field is
 * `'unknown'` — never a guess.
 */
import express from 'express'

/** Read the revision the RUNNING process was built from. Pure; no fs, no shell. */
export function servedRevision(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    env.GIT_REVISION,
    env.BUILD_REVISION,
    env.RAILWAY_GIT_COMMIT_SHA,
    env.GIT_SHA,
    env.SOURCE_VERSION,
    env.HEROKU_SLUG_COMMIT,
  ]
  const found = candidates.find((value) => typeof value === 'string' && value.trim().length > 0)
  return found ? found.trim() : 'unknown'
}

/** The revision was resolved from a real deployment env, not a local default. */
export function revisionKnown(env: NodeJS.ProcessEnv = process.env): boolean {
  return servedRevision(env) !== 'unknown'
}

export const startedAt = new Date().toISOString()

export const versionRouter = express.Router()

/**
 * GET /api/version — unauthenticated, mounted before the generic /api rate
 * limiter so a deploy probe can never be throttled into a false 429.
 */
versionRouter.get('/version', (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.json({
    service: 'loop-gpt-backend',
    revision: servedRevision(),
    startedAt,
    node: process.version,
  })
})
