/**
 * Bot approval modes. Ask pauses for every tool. Auto runs safe tools and
 * still asks for computer, terminal, and connector tools. Accept all skips
 * the card except create_custom_tool, which always asks.
 */
import fs from 'fs'
import path from 'path'

export type ApprovalMode = 'ask' | 'safe' | 'accept'
export type ApprovalCategory = 'computer' | 'terminal' | 'tool' | 'safe'
export type ToolGate = 'allow' | 'approval'

const MODES = new Set<ApprovalMode>(['ask', 'safe', 'accept'])

function modeFile(): string {
  const root = process.env.BOT_APPROVAL_DIR || path.join(process.env.AGENT_DATA_DIR || path.join(__dirname, '../../data'), 'bot-approvals')
  return path.join(root, 'modes.json')
}

export function readApprovalMode(userId: string): ApprovalMode {
  try {
    const parsed = JSON.parse(fs.readFileSync(modeFile(), 'utf8')) as Record<string, string>
    const mode = parsed[userId]
    return MODES.has(mode as ApprovalMode) ? mode as ApprovalMode : 'ask'
  } catch {
    return 'ask'
  }
}

export function writeApprovalMode(userId: string, mode: ApprovalMode): ApprovalMode {
  const next = MODES.has(mode) ? mode : 'ask'
  let all: Record<string, string> = {}
  try { all = JSON.parse(fs.readFileSync(modeFile(), 'utf8')) } catch { all = {} }
  all[userId] = next
  fs.mkdirSync(path.dirname(modeFile()), { recursive: true })
  fs.writeFileSync(modeFile(), JSON.stringify(all))
  return next
}

export function approvalCategory(name: string): ApprovalCategory {
  if (name.startsWith('computer_')) return 'computer'
  if (name === 'execute_code' || name === 'bash' || name === 'shell') return 'terminal'
  if (name.startsWith('connector__') || name === 'create_custom_tool') return 'tool'
  return 'safe'
}

export function botToolGate(mode: ApprovalMode, name: string): ToolGate {
  if (name === 'create_custom_tool') return 'approval'
  if (name === 'create_skill') return 'allow'
  if (mode === 'accept') return 'allow'
  if (mode === 'safe') return approvalCategory(name) === 'safe' ? 'allow' : 'approval'
  return 'approval'
}

export function permissionOverridesForMode(mode: ApprovalMode, names: readonly string[]): Record<string, ToolGate> {
  const overrides: Record<string, ToolGate> = {}
  for (const name of names) overrides[name] = botToolGate(mode, name)
  return overrides
}
