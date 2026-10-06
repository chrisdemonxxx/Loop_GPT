import type { LiveStep } from '../components/chat/types'

export interface CanvasDoc {
  title: string
  filename: string
  language: string
  content: string
  html: boolean
}

function fromToolArgs(args: any): CanvasDoc | null {
  if (!args || typeof args !== 'object') return null
  const content = typeof args.content === 'string' ? args.content : ''
  if (content.trim().length < 12) return null
  const format = String(args.format || '')
  const filename = String(args.filename || '')
  const html = format === 'html' || /\.html?$/i.test(filename) || /^\s*<!doctype html/i.test(content) || /^\s*<html/i.test(content)
  if (html || format === 'code' || format === 'md' || format === 'json' || format === 'txt' || filename) {
    const name = filename || (html ? 'index.html' : 'file.txt')
    const language = html ? 'html' : (name.split('.').pop() || format || 'txt')
    return { title: String(args.title || name), filename: name, language, content, html }
  }
  return null
}

/** Latest fenced block, including one that is still streaming (no closing fence). */
function fromFenced(text: string): CanvasDoc | null {
  if (!text) return null
  const closed = [...text.matchAll(/```([a-zA-Z0-9+#.]*)\n([\s\S]*?)```/g)]
  const last = closed[closed.length - 1]
  const open = text.match(/```(html|css|jsx|tsx|javascript|js|ts|python|py)\n([\s\S]{24,})$/)
  const lang = (last?.[1] || open?.[1] || '').toLowerCase()
  const body = last?.[2] || open?.[2] || ''
  if (!body || body.trim().length < 24) return null
  if (!/html|css|jsx|tsx|javascript|js|ts|python|py/.test(lang) && !/^\s*</.test(body)) return null
  const html = lang === 'html' || /^\s*<!doctype html/i.test(body) || /^\s*<html/i.test(body) || (lang === '' && /<\w+[\s>]/.test(body))
  const ext = html ? 'html' : (lang === 'python' || lang === 'py' ? 'py' : lang || 'txt')
  return { title: html ? 'index.html' : `snippet.${ext}`, filename: html ? 'index.html' : `snippet.${ext}`, language: html ? 'html' : ext, content: body.replace(/\n$/, ''), html }
}

export function canvasFromTurn(steps: LiveStep[], answer: string): CanvasDoc | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step.kind !== 'tool' || step.tool?.name !== 'create_document') continue
    const doc = fromToolArgs(step.tool.args)
    if (doc) return doc
  }
  return fromFenced(answer)
}

/** Persisted assistant steps use `{ tool, args }` rather than live `LiveStep`s. */
export function canvasFromStored(steps: Array<{ tool?: string; args?: any }>, content: string): CanvasDoc | null {
  const live: LiveStep[] = steps.map((s, i) => ({
    index: i,
    kind: 'tool',
    text: '',
    tool: s.tool ? { name: s.tool, args: s.args } : undefined,
  }))
  return canvasFromTurn(live, content)
}
