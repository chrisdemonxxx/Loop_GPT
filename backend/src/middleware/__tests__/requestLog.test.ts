import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { requestLog, recentRequests, metricsSummary, _resetRingForTests } from '../requestLog'

beforeEach(() => { _resetRingForTests() })

function mockRes(status = 200) {
  const listeners: Record<string, Array<() => void>> = {}
  const res = {
    statusCode: status,
    on: (event: string, fn: () => void) => { (listeners[event] ||= []).push(fn) },
  } as unknown as Response
  const fire = (event: string) => { for (const fn of listeners[event] || []) fn() }
  return { res, fire }
}

describe('requestLog middleware', () => {
  it('logs one structured JSON line at finish with no secrets, bodies, or headers', () => {
    const lines: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line) => lines.push(String(line)))
    const mw = requestLog()
    const { res, fire } = mockRes(200)
    mw({ method: 'GET', originalUrl: '/api/agent/x/stream?secret=never', userId: 'u1' } as unknown as Request, res, (() => undefined) as NextFunction)
    fire('finish')
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0])
    expect(entry).toMatchObject({ method: 'GET', path: '/api/agent/x/stream', status: 200, userId: 'u1' })
    expect(entry.durationMs).toBeGreaterThanOrEqual(0)
    expect(String(lines[0])).not.toContain('secret=never')
    expect(String(lines[0])).not.toContain('authorization')
    logSpy.mockRestore()
  })

  it('does not mark entries finished until finish fires (SSE duration at stream close)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const mw = requestLog()
    const { res, fire } = mockRes(200)
    mw({ method: 'POST', originalUrl: '/api/agent/new/stream' } as unknown as Request, res, (() => undefined) as NextFunction)
    expect(recentRequests(10).filter((e) => !e.finished)).toHaveLength(1)
    fire('finish')
    expect(recentRequests(10).filter((e) => e.finished)).toHaveLength(1)
    logSpy.mockRestore()
  })

  it('bounds the ring buffer and computes error rate and percentiles', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const mw = requestLog()
    for (let i = 0; i < 1050; i++) {
      const { res, fire } = mockRes(i % 20 === 0 ? 500 : 200)
      mw({ method: 'GET', originalUrl: '/api/ping' } as unknown as Request, res, (() => undefined) as NextFunction)
      fire('finish')
    }
    expect(recentRequests(2000)).toHaveLength(1000)
    const summary = metricsSummary(86400)
    expect(summary.sampleCount).toBe(1000)
    expect(summary.errorRate).toBeGreaterThan(0)
    expect(summary.p50).toBeLessThanOrEqual(summary.p95)
    expect(summary.p95).toBeLessThanOrEqual(summary.p99)
    expect(summary.slowestPaths[0].path).toBe('/api/ping')
    logSpy.mockRestore()
  })
})
