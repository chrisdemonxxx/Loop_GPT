/** Download the transcript as a PDF. A popup is not used, so a blocked
 * window.open cannot stop the export. */

function pdfEscape(value: string): string {
  let out = ''
  for (const ch of value) {
    const code = ch.codePointAt(0) || 0
    if (ch === '\\' || ch === '(' || ch === ')') out += `\\${ch}`
    else if (code >= 32 && code <= 126) out += ch
    else if (code >= 160 && code <= 255) out += `\\${code.toString(8).padStart(3, '0')}`
    else out += '?'
  }
  return out
}

function transcriptLines(title: string, messages: Array<{ role: string; content?: string | null }>): string[] {
  const lines = [title || 'conversation', '']
  for (const message of messages) {
    lines.push(message.role === 'user' ? 'You' : 'Loop GPT')
    const body = String(message.content || '').split(/\r?\n/)
    lines.push(...(body.length ? body : ['']))
    lines.push('')
  }
  const wrapped: string[] = []
  for (const line of lines) {
    if (line.length <= 90) { wrapped.push(line); continue }
    for (let i = 0; i < line.length; i += 90) wrapped.push(line.slice(i, i + 90))
  }
  return wrapped
}

function pageStream(lines: string[]): string {
  const commands = ['BT', '/F1 11 Tf', '72 740 Td', '14 TL']
  lines.forEach((line, index) => {
    const text = `(${pdfEscape(line)}) Tj`
    commands.push(index === 0 ? text : `T* ${text}`)
  })
  commands.push('ET')
  return commands.join('\n')
}

export function conversationPdfBytes(title: string, messages: Array<{ role: string; content?: string | null }>): Uint8Array {
  const wrapped = transcriptLines(title, messages)
  const chunks: string[][] = []
  for (let i = 0; i < Math.max(wrapped.length, 1); i += 42) chunks.push(wrapped.slice(i, i + 42))
  const streams = chunks.map(pageStream)
  const pageCount = streams.length
  const fontId = 3
  const offsets = [0]
  const parts = ['%PDF-1.4\n']
  const push = (id: number, body: string) => {
    offsets[id] = parts.join('').length
    parts.push(`${id} 0 obj\n${body}\nendobj\n`)
  }
  const pageIds: number[] = []
  for (let i = 0; i < pageCount; i++) pageIds.push(4 + i * 2)
  push(1, '<< /Type /Catalog /Pages 2 0 R >>')
  push(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`)
  push(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  streams.forEach((stream, index) => {
    const pageId = pageIds[index]
    const contentId = pageId + 1
    push(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`)
    push(contentId, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  })
  const body = parts.join('')
  let xref = `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  for (let i = 1; i < offsets.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  return new TextEncoder().encode(`${body}${xref}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF`)
}

export function downloadConversationPdf(title: string, messages: Array<{ role: string; content?: string | null }>) {
  const filename = `${(title || 'conversation').replace(/[^a-z0-9]/gi, '-') || 'conversation'}.pdf`
  const blob = new Blob([conversationPdfBytes(title, messages)], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
