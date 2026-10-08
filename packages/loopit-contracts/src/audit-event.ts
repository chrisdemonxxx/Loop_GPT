/**
 * Audit event types (Doc 08 §6, invariant I10).
 *
 * The audit stream is simultaneously the debugging substrate, the billing
 * substrate, and the abuse-forensics substrate. That is why it is append-only
 * and why there is no update or delete anywhere in this module: a correction is
 * a new record, never an edit to an old one.
 */

export const AUDIT_EVENT_TYPES = [
  'run.created',
  'run.completed',
  'run.failed',
  'plan.generated',
  'task.started',
  'task.completed',
  'tool.called',
  'tool.rejected',
  'model.called',
  'sandbox.leased',
  'sandbox.recycled',
  'egress.allowed',
  'egress.denied',
  'gate.requested',
  'gate.approved',
  'gate.rejected',
  'checkpoint.created',
  'checkpoint.restored',
  'secret.injected',
  'secret.revoked',
  'deploy.executed',
  'killswitch.tripped',
  'abuse.flagged',
  'abuse.signal.ingested',
  'abuse.action',
  'abuse.allowlisted',
  'abuse.operator.suspend',
  'abuse.operator.unsuspend',
  'abuse.operator.kill_sandbox',
  'abuse.operator.throttle',
  'quota.exceeded',
] as const

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number]

export type ActorKind = 'user' | 'agent' | 'system' | 'service'

/**
 * Which plane the event happened in.
 *
 * Generated code runs only in the data plane and must therefore only ever
 * produce data-plane events. A `control`-plane event attributed to an `agent`
 * actor is an invariant I1 violation and is alertable.
 */
export type Plane = 'control' | 'data' | 'deployment' | 'user_app'

export type Outcome = 'allowed' | 'denied' | 'success' | 'failure' | 'pending'

export interface Actor {
  kind: ActorKind
  id?: string
  service?: string
}

export interface Cost {
  input_tokens?: number
  output_tokens?: number
  /** Prompt tokens served from the prefix cache. Not charged. */
  cached_input_tokens?: number
  credits?: number
  usd?: number
  model?: string
}

export interface AuditEvent {
  event_id: string
  /** RFC 3339 timestamp. */
  occurred_at: string
  type: AuditEventType
  actor: Actor
  tenant_id: string
  project_id?: string
  run_id?: string
  task_id?: string
  sandbox_lease_id?: string
  /** OTel trace id, so an audit record joins to its telemetry. */
  trace_id?: string
  plane?: Plane
  outcome?: Outcome
  cost?: Cost
  /** Event-specific payload. Must never contain secrets or credentials. */
  detail?: Record<string, unknown>
}

/**
 * Detects the one attribution that should never appear: agent-authored activity
 * in the control plane (invariant I1).
 */
export function violatesPlaneSeparation(event: AuditEvent): boolean {
  return event.actor.kind === 'agent' && event.plane === 'control'
}
