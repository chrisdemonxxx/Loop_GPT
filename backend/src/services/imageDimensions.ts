/**
 * Image dimension sniffing (audit P4): reads the intrinsic width/height from
 * PNG/JPEG/WebP headers so chat messages can persist them in metadata —
 * letting the client set explicit <img width/height> and eliminate layout
 * shift. Header-only parsing, no decoding.
 */

export interface ImageDimensions {
  width: number
  height: number
}

/** Parse PNG (IHDR), JPEG (SOF markers), or WebP (VP8X/VP8/VP8L) headers. */
export function imageDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 24) return null
  // PNG: 8-byte signature, then IHDR at offset 16 (big-endian u32 width/height).
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    if (buffer.length < 24) return null
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  // JPEG: walk segments to an SOF marker (C0–CF except C4, C8, CC).
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue }
      const marker = buffer[offset + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
      const length = buffer.readUInt16BE(offset + 2)
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof && offset + 9 <= buffer.length) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
      }
      if (length < 2) return null
      offset += 2 + length
    }
    return null
  }
  // WebP: RIFF....WEBP + VP8X (canvas, 24-bit LE) or VP8/VP8L frame header.
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16)
    if (chunk === 'VP8X' && buffer.length >= 30) {
      const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16))
      const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16))
      return { width, height }
    }
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      // Lossy: frame tag at 20, then 14-bit LE dimensions at 26.
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      // Lossless: 14-bit dimensions packed after the signature byte.
      const bits = buffer.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
  }
  return null
}

/** Parse a data URI's bytes (base64 payload) for its intrinsic dimensions. */
export function dataUriDimensions(dataUri: string): ImageDimensions | null {
  const comma = dataUri.indexOf(',')
  if (comma === -1) return null
  try {
    return imageDimensions(Buffer.from(dataUri.slice(comma + 1), 'base64'))
  } catch { return null }
}
