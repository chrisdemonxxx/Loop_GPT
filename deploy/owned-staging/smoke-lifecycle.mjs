// Shared by the real Docker smoke and resource-free failure-path regressions.
export async function withSmokeCleanup({ run, cleanup, onSuccess }) {
  const failures = []
  try { await run() } catch (error) { failures.push(error) }
  try { await cleanup() } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Smoke and cleanup failed')
  onSuccess()
}

export async function cleanupSmoke({ docker, compose, project }) {
  const fixtureLabel = `loop.owned-smoke=${project}`
  const composeLabel = `com.docker.compose.project=${project}`
  const list = (kind, label) => docker(kind === 'container'
    ? ['ps', '-aq', '--filter', `label=${label}`]
    : [kind, 'ls', '-q', '--filter', `label=${label}`])
  const remove = (kind, label) => {
    const ids = list(kind, label).split(/\s+/).filter(Boolean)
    if (ids.length) docker(kind === 'container' ? ['rm', '-f', ...ids] : [kind, 'rm', ...ids])
  }
  const failures = []
  const attempt = (name, action) => {
    try { action() } catch { failures.push(new Error(`${name} failed for LOCAL project ${project}`)) }
  }
  // Labels are unique to this run. Never prune globally or touch unrelated names.
  attempt('Fixture container cleanup', () => remove('container', fixtureLabel))
  attempt('Compose cleanup', () => docker([...compose, 'down', '--volumes', '--remove-orphans']))
  attempt('Fixture network cleanup', () => remove('network', fixtureLabel))
  for (const kind of ['container', 'network', 'volume']) {
    for (const label of [fixtureLabel, composeLabel]) {
      attempt(`${kind} absence verification`, () => {
        if (list(kind, label)) throw new Error('Owned resources remain')
      })
    }
  }
  if (failures.length) throw new AggregateError(failures, `Cleanup failed for LOCAL project ${project}`)
}
