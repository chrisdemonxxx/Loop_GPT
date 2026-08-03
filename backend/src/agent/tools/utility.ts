/**
 * Small built-in utility tools that demonstrate tool-calling without external
 * services: current time and a safe arithmetic calculator.
 */
import type { ToolDefinition } from '../types'

export const currentTimeTool: ToolDefinition = {
  name: 'get_current_time',
  source: 'builtin',
  description: 'Get the current date and time, optionally for a given IANA timezone (e.g. "Asia/Tokyo").',
  parameters: {
    type: 'object',
    properties: {
      timezone: { type: 'string', description: 'IANA timezone name. Defaults to UTC.' },
    },
  },
  async handler(args) {
    const tz = args.timezone ? String(args.timezone) : 'UTC'
    try {
      const now = new Date()
      const formatted = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        dateStyle: 'full',
        timeStyle: 'long',
      }).format(now)
      return { content: `Current time in ${tz}: ${formatted}`, data: { iso: now.toISOString(), timezone: tz } }
    } catch {
      return { content: `Unknown timezone "${tz}".`, isError: true }
    }
  },
}

/** Evaluate a arithmetic expression safely (numbers and + - * / ( ) . % only). */
function safeEval(expr: string): number {
  if (!/^[\d\s+\-*/().%]+$/.test(expr)) throw new Error('Only arithmetic is allowed.')
  // eslint-disable-next-line no-new-func
  const fn = new Function(`"use strict"; return (${expr});`)
  const result = fn()
  if (typeof result !== 'number' || !isFinite(result)) throw new Error('Not a finite number.')
  return result
}

export const calculatorTool: ToolDefinition = {
  name: 'calculator',
  source: 'builtin',
  description: 'Evaluate a basic arithmetic expression (e.g. "3 * (4 + 5) / 2").',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'The arithmetic expression to evaluate.' },
    },
    required: ['expression'],
  },
  async handler(args) {
    const expr = String(args.expression || '')
    try {
      return { content: `${expr} = ${safeEval(expr)}` }
    } catch (error: any) {
      return { content: `Cannot evaluate: ${error?.message || error}`, isError: true }
    }
  },
}
