/**
 * Tool call types (Doc 04 §3).
 *
 * These mirror `schemas/tool-call.schema.json`. The schema is the authority —
 * these types exist so the TypeScript control plane gets compile-time safety.
 *
 * The tool surface is deliberately small and deliberately excludes any
 * whole-file write. Every edit is a unified diff validated against the current
 * file, so a stale read is rejected rather than silently clobbering work
 * (invariant I6).
 */

/** Every tool the agent may invoke. There is no `write_file` here, by design. */
export const TOOL_NAMES = [
  'read_file',
  'search_code',
  'apply_patch',
  'run_shell',
  'browser',
  'provision',
  'deploy',
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

/**
 * Tools that mutate something outside the sandbox and therefore require an
 * explicit, human-approved confirmation gate before execution (invariant I7).
 */
export const DESTRUCTIVE_TOOLS: readonly ToolName[] = ['deploy'] as const

export function isDestructive(tool: ToolName): boolean {
  return DESTRUCTIVE_TOOLS.includes(tool)
}

export interface ReadFileArgs {
  path: string
  start_line?: number
  end_line?: number
}

export interface SearchCodeArgs {
  query: string
  glob?: string
  max_results?: number
}

export interface ApplyPatchArgs {
  /** A unified diff. Applied all-or-nothing across every file it touches. */
  patch: string
}

export interface RunShellArgs {
  command: string
  cwd?: string
  timeout_seconds?: number
}

export type BrowserAction =
  'goto' | 'click' | 'fill' | 'assert_text' | 'screenshot' | 'console_errors' | 'smoke'

export interface BrowserArgs {
  action: BrowserAction
  /** App-relative path, resolved against the authenticated preview proxy. */
  path?: string
  selector?: string
  value?: string
  flow?: string
}

export type ProvisionResource = 'table' | 'auth' | 'storage_bucket' | 'edge_function' | 'seed'

export interface ProvisionArgs {
  resource: ProvisionResource
  /** Row-level security is emitted by the tool, never requested by the agent (I9). */
  spec?: Record<string, unknown>
}

export interface DeployArgs {
  target: 'managed' | 'git' | 'user_cloud'
  environment?: 'preview' | 'prod'
}

interface ToolCallBase<TName extends ToolName, TArgs> {
  /** Idempotency key. Retries reuse it so a replayed call is not a second effect. */
  call_id?: string
  tool: TName
  args: TArgs
  /** Advisory only. Never used for authorization — the agent does not authorize itself. */
  reason?: string
}

export type ToolCall =
  | ToolCallBase<'read_file', ReadFileArgs>
  | ToolCallBase<'search_code', SearchCodeArgs>
  | ToolCallBase<'apply_patch', ApplyPatchArgs>
  | ToolCallBase<'run_shell', RunShellArgs>
  | ToolCallBase<'browser', BrowserArgs>
  | ToolCallBase<'provision', ProvisionArgs>
  | ToolCallBase<'deploy', DeployArgs>

/**
 * Rejects absolute paths and parent traversal, mirroring the `projectPath`
 * pattern in the schema.
 *
 * This is a convenience for callers, not the security boundary: the boundary is
 * schema validation on receipt plus the sandbox's own filesystem confinement.
 */
export function isProjectPath(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false
  if (value.startsWith('/')) return false
  return !value.split('/').includes('..')
}
