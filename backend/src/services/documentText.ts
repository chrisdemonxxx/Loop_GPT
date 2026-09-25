/**
 * Server-side document text extraction for knowledge ingestion and chat
 * attachments (brief §2.2 / GAP-041). Supported: PDF, DOCX, XLSX, CSV, TXT,
 * MD. Everything is capped at MAX_DOC_CHARS so one upload can never blow up
 * an embedding batch or a prompt.
 */
import * as XLSX from 'xlsx'

export const MAX_DOC_CHARS = 200_000
export const MAX_DOC_BYTES = 15 * 1024 * 1024

export interface ExtractedDoc {
  text: string
  kind: 'pdf' | 'docx' | 'xlsx' | 'csv' | 'text'
  truncated: boolean
  chars: number
}

function cap(text: string): ExtractedDoc['text'] {
  return text.length > MAX_DOC_CHARS ? text.slice(0, MAX_DOC_CHARS) : text
}

/** Extract plain text from an uploaded document buffer, by extension. */
export async function extractDocumentText(buffer: Buffer, filename: string): Promise<ExtractedDoc> {
  const name = (filename || '').toLowerCase()
  const full = buffer.length
  if (full > MAX_DOC_BYTES) throw Object.assign(new Error('File exceeds the 15MB limit.'), { status: 413 })

  const finish = (kind: ExtractedDoc['kind'], raw: string): ExtractedDoc => {
      // eslint-disable-next-line no-control-regex -- deliberate: strip NUL bytes from extracted document text
    const text = cap(raw.replace(/\u0000/g, '').trim())
    return { text, kind, truncated: raw.length > MAX_DOC_CHARS, chars: text.length }
  }

  if (name.endsWith('.pdf') || buffer.subarray(0, 4).toString() === '%PDF') {
    const pdfParse = (await import('pdf-parse')).default as any
    const parsed = await pdfParse(buffer)
    return finish('pdf', String(parsed?.text || ''))
  }
  if (name.endsWith('.docx')) {
    const mammoth = await import('mammoth')
    const { value } = await mammoth.extractRawText({ buffer })
    return finish('docx', String(value || ''))
  }
  if (name.endsWith('.xlsx')) {
    const wb = XLSX.read(buffer, { type: 'buffer' })
    const parts: string[] = []
    for (const sheetName of wb.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName], { FS: ' | ' })
      if (csv.trim()) parts.push(`## Sheet: ${sheetName}\n${csv}`)
    }
    return finish('xlsx', parts.join('\n\n'))
  }
  if (name.endsWith('.csv') || name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.markdown')) {
    return finish(name.endsWith('.csv') ? 'csv' : 'text', buffer.toString('utf8'))
  }
  throw Object.assign(new Error('Unsupported document type. Use PDF, DOCX, XLSX, CSV, TXT or MD.'), { status: 415 })
}

/** Inline text block prepended to the user message for a chat attachment. */
export function documentInline(name: string, text: string): string {
  const INLINE_CAP = 24_000
  const body = text.length > INLINE_CAP ? `${text.slice(0, INLINE_CAP)}\n…(truncated — the full text is ${text.length} characters)` : text
  return `[Attached document "${name}" — extracted text follows]\n"""\n${body}\n"""`
}

export function isDocumentFilename(filename: string): boolean {
  const n = (filename || '').toLowerCase()
  return /\.(pdf|docx|xlsx|csv|txt|md|markdown)$/.test(n)
}
