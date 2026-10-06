'use strict'

/**
 * Staged boot loader (sand's main.cjs pattern, scaled to our size):
 * the critical pre-ready init (protocol scheme registration + window-state
 * access) runs to completion FIRST via main-core.cjs; only then does the
 * remainder (windows, lifecycle, handlers) load via main-app.cjs.
 *
 * Rationale: registerSchemesAsPrivileged throws after the app is ready, so
 * core init must always win the race against the remainder — the stage split
 * makes that ordering structural, not conventional.
 */
const core = require('./main-core.cjs')

core.ready
  .then(() => {
    require('./main-app.cjs')
  })
  .catch((err) => core.noteStartupFailed(err))