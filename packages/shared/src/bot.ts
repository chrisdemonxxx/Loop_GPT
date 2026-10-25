// ── Loop Bot shared contracts (mirror backend agentTasks.ts / botRuns.ts /
//    routes/bot.ts) ───────────────────────────────────────────────────────────
// One source of truth for the bot domain, consumed by the web app, the
// desktop shell, and (via re-export shims) every legacy import path.

export type BotTaskStatus = 'queued' | 'processing' | 'succeeded' | 'dead_letter' | 'cancelled'
export type BotRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/** Tool-pack seed for the persistent box (computer wake), not an AgentTask field. */
export type BotBoxTaskType = 'default' | 'coding' | 'research' | 'ops' | 'teach'

/** @deprecated Use BotBoxTaskType — taskType is not an AgentTask column. */
export type BotTaskType = BotBoxTaskType

export interface BotTask {
  id: string
  kind: 'ops' | 'scheduled' | 'teach'
  goal: string
  status: BotTaskStatus
  schedule: string | null
  model: string | null
  priority: number
  attempts: number
  failures: number
  nextAttemptAt: string
  cancelRequested: boolean
  lastErrorCode: string | null
  /** Dedicated-computer request on this task (enabled + optional TTL). */
  computer?: { enabled: boolean; ttlMinutes?: number } | null
  /** Named bot this task runs as. */
  botId?: string | null
  /** Bot thread this task was enqueued into. */
  conversationId?: string | null
  /** Audit trail — who enqueued the task. */
  createdBy?: string
  /** Latest run result text when the list/detail payload includes it. */
  result?: string | null
  createdAt: string
  updatedAt: string
}

export interface BotTaskDetail extends BotTask {
  runs: Array<{ id: string; status: BotRunStatus; error: string | null; startedAt: string; completedAt: string | null }>
}

export interface BotRun {
  id: string
  taskId: string
  status: BotRunStatus
  events: BotEvent[]
  result?: string
  artifacts?: Array<{ id: string; kind: string; name: string }>
  usage?: { tokensIn: number; tokensOut: number; model?: string }
  error?: string
  startedAt: string
  completedAt?: string | null
}

export interface BotComputer {
  active: boolean
  /** Why the stream is inactive: 'finished' (run ended, VM destroyed) or
   *  'not-running' (run not in the running state). Null while active. */
  reason?: 'finished' | 'not-running' | null
  sandboxId: string
  viewUrl: string | null
  interactiveUrl: string | null
  takeoverRequested: boolean
  /** Server-reported auto-release window for takeover (ms). */
  takeoverTimeoutMs?: number
  minutes: number | null
  startedAt: string | null
  endedAt: string | null
}

export interface BotQuota {
  plan: string
  unlimited: boolean
  computerAllowed: boolean
  computerConfigured: boolean
  cap: number | null
  used: number
  remaining: number | null
  resetsAt: string
}

export interface BotEvent {
  type: string
  seq?: number
  message?: string
  step?: number
  name?: string
  args?: any
  chunk?: string
  stream?: 'stdout' | 'stderr'
  items?: Array<{ id: string; label: string; status: string }>
  content?: string
  text?: string
  isError?: boolean
  data?: any
  artifact?: { id: string; kind: string; name: string }
  runId?: string
  /** Present on `skill_saved` teach events. */
  skillId?: string
}

/** Live feed frame (SSE + poll fallback both emit this shape). */
export interface BotFeedEvent {
  type: string
  message?: string
  name?: string
  content?: string
  text?: string
  artifact?: { id: string; name: string; kind: string; mimeType?: string }
  [key: string]: unknown
}

export interface EnqueueBotInput {
  goal: string
  kind?: 'ops' | 'scheduled' | 'teach'
  schedule?: string
  model?: string
  thinking?: 'low' | 'medium' | 'high' | 'xhigh'
  allowedTools?: string[]
  maxSteps?: number
  computer?: { enabled: boolean; ttlMinutes?: number }
  skillId?: string
  /** Named bot this task runs as. Omitted → the owner's primary Loop Bot. */
  botId?: string
  /** Bot thread the task is filed under. */
  conversationId?: string
  priority?: number
}

export interface EnqueueBotResult {
  ok: true
  task: {
    id: string
    kind: string
    status: string
    nextAttemptAt: string
    computer?: { enabled: boolean; ttlMinutes?: number } | null
  }
  suggestedSkills: BotSkillRef[]
}

export interface BotSkillRef {
  id: string
  name: string
  description: string
  triggers?: string[]
  tools?: string[]
  botId?: string
}

/** Human labels for task statuses (used by the /agents page chips). */
export const BOT_STATUS_LABEL: Record<BotTaskStatus, string> = {
  queued: 'Queued', processing: 'Running', succeeded: 'Done', dead_letter: 'Failed', cancelled: 'Cancelled',
}
export const BOT_STATUS_TONE: Record<BotTaskStatus, 'accent' | 'green' | 'rose' | 'muted'> = {
  queued: 'muted', processing: 'accent', succeeded: 'green', dead_letter: 'rose', cancelled: 'muted',
}

// ── Account / auth shared types ─────────────────────────────────────────────

export type AgentMode = 'chat' | 'agent' | 'research'

export interface StoredUser {
  id: string
  email: string
  name: string
  role?: string
  plan?: string
}
