import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { extractDocumentText, documentInline, isDocumentFilename, MAX_DOC_CHARS } from '../documentText'

describe('extractDocumentText (document ingestion, GAP-041)', () => {
  it('extracts plain text and markdown', async () => {
    const r = await extractDocumentText(Buffer.from('# Hello\n\nWorld'), 'notes.md')
    expect(r.kind).toBe('text')
    expect(r.text).toContain('Hello')
    expect(r.truncated).toBe(false)
  })

  it('extracts csv', async () => {
    const r = await extractDocumentText(Buffer.from('a,b\n1,2'), 'data.csv')
    expect(r.kind).toBe('csv')
    expect(r.text).toContain('a,b')
  })

  it('extracts xlsx sheets with headers', async () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Name', 'Qty'], ['Widget', 3]]), 'Inventory')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    const r = await extractDocumentText(buf, 'inventory.xlsx')
    expect(r.kind).toBe('xlsx')
    expect(r.text).toContain('## Sheet: Inventory')
    expect(r.text).toContain('Widget')
  })

  it('rejects unsupported types with a 415', async () => {
    await expect(extractDocumentText(Buffer.from('x'), 'evil.exe')).rejects.toMatchObject({ status: 415 })
  })

  it('caps runaway output at MAX_DOC_CHARS', async () => {
    const huge = 'a'.repeat(MAX_DOC_CHARS + 5000)
    const r = await extractDocumentText(Buffer.from(huge), 'huge.txt')
    expect(r.truncated).toBe(true)
    expect(r.chars).toBe(MAX_DOC_CHARS)
  })
})

describe('documentInline', () => {
  it('wraps the text with the document name and truncates long bodies', () => {
    const short = documentInline('report.pdf', 'tiny body')
    expect(short).toContain('report.pdf')
    expect(short).toContain('tiny body')
    const long = documentInline('big.pdf', 'b'.repeat(30_000))
    expect(long.length).toBeLessThan(30_000)
    expect(long).toContain('truncated')
  })
})

describe('isDocumentFilename', () => {
  it('matches document extensions only', () => {
    expect(isDocumentFilename('a.pdf')).toBe(true)
    expect(isDocumentFilename('a.DOCX')).toBe(true)
    expect(isDocumentFilename('photo.png')).toBe(false)
  })
})
