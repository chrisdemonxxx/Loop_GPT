import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadConversationPdf } from '../exportPdf'

describe('PDF export', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('downloads a pdf file instead of opening a window', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const blobs: Blob[] = []
    if (typeof URL.createObjectURL !== 'function') {
      URL.createObjectURL = () => ''
      URL.revokeObjectURL = () => {}
    }
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob)
      return 'blob:pdf'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const clicks: HTMLAnchorElement[] = []
    const click = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { clicks.push(this) }
    try {
      downloadConversationPdf('My chat', [{ role: 'user', content: 'Hello from chat' }])
      expect(open).not.toHaveBeenCalled()
      expect(clicks).toHaveLength(1)
      expect(clicks[0].download).toBe('My-chat.pdf')
      expect(blobs[0]?.type).toBe('application/pdf')
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsText(blobs[0])
      })
      expect(text.startsWith('%PDF')).toBe(true)
      expect(text).toContain('Hello from chat')
    } finally {
      HTMLAnchorElement.prototype.click = click
    }
  })
})
