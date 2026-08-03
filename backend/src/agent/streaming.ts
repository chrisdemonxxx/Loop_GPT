/**
 * Server-Sent Events (SSE) helpers for streaming agent runs to the browser.
 */
import type { Response } from 'express'
import type { AgentEvent } from './types'

export function initSSE(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // disable nginx buffering
  res.flushHeaders?.()
  // Prime the stream so proxies flush headers immediately.
  res.write(': connected\n\n')
}

export function sendEvent(res: Response, event: AgentEvent) {
  if (res.writableEnded) return
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

export function endSSE(res: Response) {
  if (res.writableEnded) return
  sendEvent(res, { type: 'done' })
  res.end()
}

/** Build an emit() closure bound to a response for use as ToolContext.emit. */
export function makeEmitter(res: Response) {
  return (event: AgentEvent) => sendEvent(res, event)
}
