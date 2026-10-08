/**
 * Tool names user extensions may never claim. A custom tool, data plugin or
 * connector that registers a built-in's name would otherwise shadow it inside
 * a run (and inherit its permission defaults).
 */
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'web_search', 'web_fetch', 'get_current_time', 'calculator', 'generate_image', 'generate_video',
  'create_document', 'transcribe_audio', 'speak_text', 'ocr_image', 'execute_code', 'search_knowledge',
  'remember', 'generate_style', 'create_skill', 'create_custom_tool',
  'computer_screenshot', 'computer_click', 'computer_move', 'computer_scroll', 'computer_drag',
  'computer_type', 'computer_press', 'computer_launch', 'computer_wait',
])

/** Prefixes owned by server-namespaced tool families. */
const RESERVED_PREFIXES = ['connector__', 'connection_', 'mcp__', 'computer_', 'system_', 'loop_', 'loopit_']

export function isReservedToolName(name: string): boolean {
  const lower = String(name || '').toLowerCase()
  return BUILTIN_TOOL_NAMES.has(lower) || RESERVED_PREFIXES.some((prefix) => lower.startsWith(prefix))
}
