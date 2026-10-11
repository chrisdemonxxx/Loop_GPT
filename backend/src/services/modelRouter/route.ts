/**
 * Public router API. One entry for chat turns, one for media turns; both run
 * deterministic rules first and only escalate to the router model (JEV) for
 * genuinely ambiguous work. Every decision carries `decidedBy` + `reason` for
 * logs and the UI's auto chip.
 */
import { resolveChatTarget, smartRouteTask, type ChatTarget, type ChatTier } from '../chatModels'
import { classifyChatTurn, routerConfigured } from './classifier'
import { routeMediaTurn, type MediaRouteDecision } from './rules'

export interface ChatRouteDecision {
  target: ChatTarget
  decidedBy: 'pin' | 'rule' | 'jev'
  reason: string
}

/**
 * Chat tier selection. Order:
 *   1. caller-pinned model (handled before this call — see hostedModelRequest)
 *   2. rules (smartRouteTask): research, image attachments, heavy context/tools
 *      — these never need a model's opinion
 *   3. JEV: the remaining default-fast turns, where a hard prompt might
 *      deserve the flagship/deep-reasoning tier. JEV can only UPGRADE from
 *      standard, never downgrade a rule's pick; any failure keeps the rule.
 */
export async function routeChatTurn(opts: {
  prompt: string
  mode: string
  hasImage: boolean
  toolNames: string[]
  contentLength: number
}): Promise<ChatRouteDecision> {
  const ruled = smartRouteTask(opts.contentLength, opts.mode, opts.hasImage, opts.toolNames)

  // Only default-fast (standard-tier, no-image) turns are ambiguous enough to
  // warrant the router model. Everything else is already confidently placed.
  if (ruled.tier !== 'standard' || opts.hasImage || opts.mode === 'research' || !routerConfigured()) {
    return { target: ruled, decidedBy: 'rule', reason: 'deterministic rules' }
  }

  const verdict = await classifyChatTurn({
    prompt: opts.prompt,
    hasImage: opts.hasImage,
    mode: opts.mode,
    toolNames: opts.toolNames,
  })
  if (!verdict) return { target: ruled, decidedBy: 'rule', reason: 'rules (router model unavailable)' }

  // JEV may only upgrade a standard-tier default to a heavier tier. A
  // 'standard' or 'vision' answer without an image changes nothing.
  if (verdict.tier === 'large' || verdict.tier === 'glm5') {
    const upgraded = resolveChatTarget(verdict.tier)
    // The heavy tier must actually be configured, otherwise the pick is a lie.
    if (upgraded.tier === verdict.tier) {
      return { target: upgraded, decidedBy: 'jev', reason: verdict.reason || `router model → ${verdict.tier}` }
    }
  }
  return { target: ruled, decidedBy: 'jev', reason: verdict.reason || 'router model → standard' }
}

export { routeMediaTurn }
export type { MediaRouteDecision }
