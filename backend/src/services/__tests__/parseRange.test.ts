import { describe, expect, it } from 'vitest'
import { parseRange } from '../privateFiles'

/** Byte-range parsing (audit P3): absent → null, unsatisfiable → 'invalid',
 * satisfiable → the inclusive {start, end} slice. */

const TOTAL = 1000

describe('parseRange', () => {
  it('returns null without a header or for non-byte ranges', () => {
    expect(parseRange(undefined, TOTAL)).toBeNull()
    expect(parseRange(null, TOTAL)).toBeNull()
    expect(parseRange('', TOTAL)).toBeNull()
    expect(parseRange('items=0-9', TOTAL)).toBeNull()
    expect(parseRange('bytes=abc', TOTAL)).toBeNull()
    expect(parseRange('bytes=', TOTAL)).toBeNull()
  })

  it('parses inclusive start-end ranges, clamping the end to total-1', () => {
    expect(parseRange('bytes=0-9', TOTAL)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=500-999', TOTAL)).toEqual({ start: 500, end: 999 })
    expect(parseRange('bytes=0-5000', TOTAL)).toEqual({ start: 0, end: 999 })
    expect(parseRange('  bytes=10-20  ', TOTAL)).toEqual({ start: 10, end: 20 })
  })

  it('parses open-ended ranges as start..total-1', () => {
    expect(parseRange('bytes=100-', TOTAL)).toEqual({ start: 100, end: 999 })
    expect(parseRange('bytes=0-', TOTAL)).toEqual({ start: 0, end: 999 })
  })

  it('parses suffix ranges (bytes=-N) as the last N bytes', () => {
    expect(parseRange('bytes=-50', TOTAL)).toEqual({ start: 950, end: 999 })
    expect(parseRange('bytes=-2000', TOTAL)).toEqual({ start: 0, end: 999 })
  })

  it('marks unsatisfiable or malformed ranges invalid', () => {
    expect(parseRange('bytes=-0', TOTAL)).toBe('invalid')
    expect(parseRange('bytes=1000-', TOTAL)).toBe('invalid') // start === total
    expect(parseRange('bytes=1000-1200', TOTAL)).toBe('invalid')
    expect(parseRange('bytes=500-100', TOTAL)).toBe('invalid') // end < start
    expect(parseRange('bytes=--', TOTAL)).toBeNull() // not a range form
  })

  it('handles empty resources by rejecting any concrete start', () => {
    expect(parseRange('bytes=0-0', 0)).toBe('invalid')
    expect(parseRange('bytes=-5', 0)).toBe('invalid')
    expect(parseRange(undefined, 0)).toBeNull()
  })
})
