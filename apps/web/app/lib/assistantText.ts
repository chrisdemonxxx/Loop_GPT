/** Hide inline tool-call payloads. Mirrors backend parseInlineToolCalls:
 *  <tool_call> tags, ```json fences, and bare {"tool":...} objects. */

function looksLikeToolCall(raw: string): boolean {
  try {
    const obj = JSON.parse(raw.trim())
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
    const name = obj.tool || obj.tool_name || obj.name || obj.action
    if (typeof name !== 'string' || !name) return false
    return 'arguments' in obj || 'args' in obj || 'parameters' in obj || 'input' in obj || 'tool' in obj || 'tool_name' in obj
  } catch {
    return false
  }
}

function extractBalancedObjects(s: string): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue
    let depth = 0
    let inStr = false
    let esc = false
    for (let j = i; j < s.length; j++) {
      const c = s[j]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          out.push(s.slice(i, j + 1))
          i = j
          break
        }
      }
    }
  }
  return out
}

export function stripInlineToolPayload(content: string): string {
  if (!content) return ''
  let text = content.replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/gi, '')
  text = text.replace(/<tool_code>\s*[\s\S]*?\s*<\/tool_code>/gi, '')
  text = text.replace(/```(?:json|tool_call)?\s*([\s\S]*?)```/gi, (block, inner) => (
    looksLikeToolCall(String(inner)) ? '' : block
  ))
  for (const obj of extractBalancedObjects(text)) {
    if (looksLikeToolCall(obj)) text = text.replace(obj, '')
  }
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Close a dangling fence or backtick so markdown cannot swallow the rest of the turn. */
export function balanceMarkdown(text: string): string {
  if (!text) return ''
  const fences = text.split('```').length - 1
  let out = fences % 2 === 1 ? `${text}\n\`\`\`` : text
  const outside = out.replace(/```[\s\S]*?```/g, '')
  const singles = outside.match(/(^|[^`])`(?!`)/g)
  if (singles && singles.length % 2 === 1) out += '`'
  return out
}

/** What the user should read. Tool JSON and the internal step-budget heading never surface. */
export function presentAssistantText(raw: string): string {
  let text = stripInlineToolPayload(raw || '')
  text = text.replace(/^#{1,6}\s*Here is what I found so far:\s*/gim, '')
  text = text.replace(/^\s*Here is what I found so far:\s*/gim, '')
  return balanceMarkdown(text).trim()
}

export function narrateTool(name: string, done: boolean, failed = false): string {
  const label = String(name || 'that').replace(/_/g, ' ')
  if (failed) return `I couldn't finish ${label}.`
  if (!done) {
    if (name === 'create_document') return 'I\'m writing that now. I\'ll share it as soon as it\'s ready.'
    if (name === 'web_search' || name === 'web_fetch') return 'I\'m looking that up.'
    if (name === 'generate_image') return 'I\'m generating the image.'
    if (name === 'execute_code') return 'I\'m running the code.'
    return `I'm working on ${label}.`
  }
  if (name === 'create_document') return 'The file is ready.'
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} is done.`
}

/** Abort and transport failures the user should not see as raw exceptions. */
export function presentStreamError(message: string): string | null {
  const msg = String(message || '').trim()
  if (!msg) return null
  if (/abort|bodystreambuffer|aborterror|the user aborted|signal is aborted/i.test(msg)) return null
  if (/failed to fetch|networkerror|network error|load failed/i.test(msg)) return 'The connection dropped. Check your network and try again.'
  if (/^request failed\b/i.test(msg)) return 'That request failed. Try again.'
  if ((/error:|exception|at\s+\w+\s+\(/i.test(msg)) && msg.length > 160) return 'Something went wrong on that run. Try again.'
  return msg
}
