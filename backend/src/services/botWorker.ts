/**
 * Bot task worker: claims queued AgentTask rows and executes them sequentially
 * (v1: one task at a time). Mirrors the settlement worker's shape — bounded
 * options, batch summaries, exit codes — so the supervisor and operators get
 * identical semantics across all four workers.
 */
import { prisma, hasDb } from './prisma'
import { AgentTaskError, claimAgentTasks } from './agentTasks'
import { executeBotTask } from './botRunner'

export interface BotWorkerOptions {
  batchSize?: number
  leaseMs?: number
  pollMs?: number
}

export function botWorkerOptions(options: BotWorkerOptions = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !['batchSize', 'leaseMs', 'pollMs'].includes(key))) throw new AgentTaskError('invalid_request')
  const result = { batchSize: options.batchSize ?? 1, leaseMs: options.leaseMs ?? 600_000, pollMs: options.pollMs ?? 2000 }
  const bounds = { batchSize: [1, 25], leaseMs: [30_000, 3_600_000], pollMs: [100, 60_000] }
  for (const key of Object.keys(bounds) as (keyof typeof bounds)[]) {
    if ((key in options && options[key] === null) || !Number.isSafeInteger(result[key]) || result[key] < bounds[key][0] || result[key] > bounds[key][1]) {
      throw new AgentTaskError('invalid_request')
    }
  }
  return result
}

export interface BotBatchResult {
  claimed: number
  succeeded: number
  retry: number
  cancelled: number
  dead_letter: number
  lease_lost: number
  unavailable: number
  unprocessed: number
  aborted: boolean
}

export function botWorkerExitCode(result: BotBatchResult): number {
  if (result.dead_letter) return 3
  return result.aborted || result.unprocessed || result.unavailable || result.retry || result.lease_lost ? 1 : 0
}

/** One bounded batch: claim up to batchSize due tasks, run each to completion. */
export async function runBotTaskBatch(options: BotWorkerOptions = {}, signal?: AbortSignal): Promise<BotBatchResult> {
  const normalized = botWorkerOptions(options)
  if (!hasDb || !prisma) throw new AgentTaskError('unavailable')
  const summary: BotBatchResult = {
    claimed: 0, succeeded: 0, retry: 0, cancelled: 0, dead_letter: 0,
    lease_lost: 0, unavailable: 0, unprocessed: 0, aborted: false,
  }
  // Claim only what we will immediately run — no locally queued leases burning time.
  while (!signal?.aborted && summary.claimed < normalized.batchSize) {
    const claims = await claimAgentTasks({
      batchSize: normalized.batchSize - summary.claimed,
      leaseMs: normalized.leaseMs,
    })
    if (!claims.length) break
    summary.claimed += claims.length
    for (const claim of claims) {
      if (signal?.aborted) break
      try {
        const outcome = await executeBotTask(claim, { leaseMs: normalized.leaseMs }, signal)
        summary[outcome]++
      } catch {
        summary.unavailable++
      }
    }
  }
  summary.aborted = signal?.aborted ?? false
  summary.unprocessed = summary.claimed - summary.succeeded - summary.retry - summary.cancelled -
    summary.dead_letter - summary.lease_lost - summary.unavailable
  return summary
}
