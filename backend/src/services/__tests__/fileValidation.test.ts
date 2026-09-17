import { describe, expect, it } from 'vitest'
import { detectImageMime, safeFileName, FILE_ID } from '../privateFiles'
import { validationSchemas } from '../../middleware/validation'

describe('file input contracts', () => {
  it('does not accept arbitrary content declared to be an image', () => {
    expect(detectImageMime(Buffer.from('<script>alert(1)</script>'))).toBeNull()
  })
  it('recognizes the supported image signatures', () => {
    expect(detectImageMime(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe('image/png')
    expect(detectImageMime(Buffer.from([255, 216, 255]))).toBe('image/jpeg')
    expect(detectImageMime(Buffer.from('GIF89a'))).toBe('image/gif')
    expect(detectImageMime(Buffer.from('RIFF0000WEBP'))).toBe('image/webp')
  })
  it.each(['../../etc/passwd', 'C:\\private\\secret', '<svg>bad</svg>', '123'])('rejects a path or non-UUID identifier %s', (id) => {
    expect(FILE_ID.test(id)).toBe(false)
  })
  it('sanitizes filenames for download headers', () => {
    expect(safeFileName('../a\r\n"/b')).not.toMatch(/[\r\n"/\\]/)
    expect(safeFileName('...')).toBe('file')
  })
  it('rejects the legacy server-path message parameter even with valid text', () => {
    expect(validationSchemas.sendMessage.safeParse({ params: { conversationId: 'c' }, body: { content: 'hello', imagePath: '/etc/passwd' } }).success).toBe(false)
  })
  it('accepts an attachment-only message', () => {
    expect(validationSchemas.sendMessage.safeParse({ params: { conversationId: 'c' }, body: { attachmentId: '12345678-1234-4123-8123-123456789abc' } }).success).toBe(true)
  })
})
