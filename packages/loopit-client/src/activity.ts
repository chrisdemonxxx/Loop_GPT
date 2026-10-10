/**
 * Turns audit records into something a person can read.
 *
 * The API streams the run's real audit events, which are named for the audit
 * store rather than for a reader. What reaches the product surface is a
 * product voice: plain sentences, no event names, no tool output, no
 * commands, no stack text. The full, unredacted record still lives in the
 * audit log where an operator can read it — the timeline here is for the
 * person waiting on their app.
 */

import type { AuditStreamEvent } from './api'

export interface Activity {
  id: string
  at: string
  title: string
  body: string
  tone: 'neutral' | 'good' | 'bad' | 'work'
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  return ''
}

/** Plain-language name for each tool the builder reaches for. */
const TOOL_TITLES: Record<string, string> = {
  read_file: 'Reviewed part of the project',
  search_code: 'Scanned the project',
  apply_patch: 'Wrote changes',
  run_shell: 'Ran a setup command',
  browser: 'Checked the result in a browser',
  provision: 'Set up a data table',
  deploy: 'Prepared a deployment',
}

export function toActivity(event: AuditStreamEvent, index: number): Activity {
  const detail = event.detail ?? {}
  const tool = asText(detail.tool)
  const id = `${event.occurred_at}-${index}`
  const at = new Date(event.occurred_at).toLocaleTimeString()

  switch (event.type) {
    case 'task.started':
      return { id, at, title: 'Started building', body: '', tone: 'work' }
    case 'tool.called':
      return {
        id,
        at,
        title: TOOL_TITLES[tool] ?? 'Working on the build',
        body: describeWork(detail),
        tone: 'work',
      }
    case 'tool.result':
    case 'tool.completed':
      return {
        id,
        at,
        title: event.outcome === 'failure' ? 'A step did not go as planned' : 'Step finished',
        body: '',
        tone: event.outcome === 'failure' ? 'bad' : 'neutral',
      }
    case 'verification.completed':
      return {
        id,
        at,
        title:
          event.outcome === 'success'
            ? 'The build passed its checks'
            : 'The checks found something to fix',
        body: '',
        tone: event.outcome === 'success' ? 'good' : 'bad',
      }
    case 'task.stopped':
    case 'task.completed':
      return {
        id,
        at,
        title: event.outcome === 'success' ? 'Build verified' : 'The build stopped',
        body: '',
        tone: event.outcome === 'success' ? 'good' : 'bad',
      }
    default:
      // Unknown event types still pace the timeline without leaking their
      // internal names.
      return { id, at, title: 'Working…', body: '', tone: 'neutral' }
  }
}

/**
 * The one detail worth showing: which files a change touched. File names are
 * something a person recognises; commands, queries, and tool output are not
 * product language, so they stay in the audit log.
 */
function describeWork(detail: Record<string, unknown>): string {
  const path = asText(detail.path)
  if (path) return path
  const args = detail.args
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const record = args as Record<string, unknown>
    if (typeof record.patch === 'string') {
      const targets = [...record.patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1])
      return targets.length ? targets.join(', ') : ''
    }
  }
  return ''
}
