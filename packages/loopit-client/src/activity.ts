/**
 * Turns audit records into something a person can read.
 *
 * The API streams the run's real audit events, which are named for the audit
 * store rather than for a reader. The raw type is always kept alongside the
 * friendly line so the timeline can be reconciled with the audit log.
 */

import type { AuditStreamEvent } from './api'

export interface Activity {
  id: string
  at: string
  rawType: string
  title: string
  body: string
  tone: 'neutral' | 'good' | 'bad' | 'work'
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

const TOOL_VERBS: Record<string, string> = {
  read_file: 'Read a file',
  search_code: 'Searched the project',
  apply_patch: 'Edited files',
  run_shell: 'Ran a command',
  browser: 'Opened the preview',
  provision: 'Provisioned the database',
  deploy: 'Deployed',
}

export function toActivity(event: AuditStreamEvent, index: number): Activity {
  const detail = event.detail ?? {}
  const tool = asText(detail.tool)
  const id = `${event.occurred_at}-${index}`
  const at = new Date(event.occurred_at).toLocaleTimeString()

  switch (event.type) {
    case 'task.started':
      return { id, at, rawType: event.type, title: 'Run started', body: asText(detail.goal), tone: 'neutral' }
    case 'tool.called':
      return {
        id,
        at,
        rawType: event.type,
        title: TOOL_VERBS[tool] ?? `Called ${tool || 'a tool'}`,
        body: describeArgs(detail),
        tone: 'work',
      }
    case 'tool.result':
    case 'tool.completed':
      return {
        id,
        at,
        rawType: event.type,
        title: event.outcome === 'failure' ? 'That did not work' : 'Result',
        body: asText(detail.observation ?? detail.output ?? detail.summary),
        tone: event.outcome === 'failure' ? 'bad' : 'neutral',
      }
    case 'verification.completed':
      return {
        id,
        at,
        rawType: event.type,
        title: event.outcome === 'success' ? 'Verification passed' : 'Verification failed',
        body: asText(detail.summary ?? detail.verdict),
        tone: event.outcome === 'success' ? 'good' : 'bad',
      }
    case 'task.stopped':
    case 'task.completed':
      return {
        id,
        at,
        rawType: event.type,
        title: `Run finished: ${asText(detail.outcome) || event.outcome || 'stopped'}`,
        body: asText(detail.summary),
        tone: event.outcome === 'success' ? 'good' : 'bad',
      }
    default:
      return {
        id,
        at,
        rawType: event.type,
        title: event.type,
        body: Object.keys(detail).length ? JSON.stringify(detail) : '',
        tone: event.outcome === 'denied' || event.outcome === 'failure' ? 'bad' : 'neutral',
      }
  }
}

function describeArgs(detail: Record<string, unknown>): string {
  const path = asText(detail.path)
  if (path) return path
  const query = asText(detail.query)
  if (query) return `for ${query}`
  const command = asText(detail.command)
  if (command) return command
  const args = detail.args
  if (args && typeof args === 'object') {
    const record = args as Record<string, unknown>
    if (typeof record.patch === 'string') {
      const targets = [...record.patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1])
      return targets.length ? targets.join(', ') : 'applied a patch'
    }
    return Object.entries(record)
      .map(([key, value]) => `${key}: ${truncate(asText(value), 120)}`)
      .join('  ')
  }
  return ''
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}
