import { describe, expect, it } from 'vitest'
import { dataUriDimensions, imageDimensions } from '../imageDimensions'

/** Header-only dimension sniffing (audit P4): PNG IHDR, JPEG SOF, WebP
 * VP8X/VP8/VP8L — the values that let the client pin <img width/height>. */

/** 3×2 PNG (grayscale, 1×1 pixel body is fine — only IHDR matters). */
const PNG_3x2 = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000003000000020806000000' +
  '9dd3dd5a0000000d4944415478da63640000000600023081d02f0000' +
  '000049454e44ae426082', 'hex')

/** Minimal JPEG with an SOF0 segment declaring 480×320. */
function jpegSof(width: number, height: number): Buffer {
  const head = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex')
  const sof = Buffer.alloc(17)
  sof.writeUInt16BE(0xffc0, 0) // SOF0
  sof.writeUInt16BE(17, 2)     // segment length
  sof[4] = 8                   // precision
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 1                   // one component
  sof[10] = 1
  return Buffer.concat([head, sof])
}

describe('imageDimensions', () => {
  it('reads PNG IHDR dimensions', () => {
    expect(imageDimensions(PNG_3x2)).toEqual({ width: 3, height: 2 })
  })

  it('reads JPEG SOF dimensions, skipping earlier segments', () => {
    expect(imageDimensions(jpegSof(480, 320))).toEqual({ width: 480, height: 320 })
  })

  it('returns null for unknown or truncated inputs', () => {
    expect(imageDimensions(Buffer.from('not an image at all'))).toBeNull()
    expect(imageDimensions(Buffer.alloc(8))).toBeNull()
    expect(imageDimensions(Buffer.alloc(0))).toBeNull()
  })

  it('parses data URIs via their base64 payloads', () => {
    expect(dataUriDimensions(`data:image/png;base64,${PNG_3x2.toString('base64')}`)).toEqual({ width: 3, height: 2 })
    expect(dataUriDimensions('data:image/png;base64,!!!not-base64!!!')).toBeNull()
    expect(dataUriDimensions('')).toBeNull()
  })
})
