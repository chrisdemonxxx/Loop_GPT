/** Map a Loop-IT run and its stream onto the bot run timeline feed.
 *  Product voice only: titles and plain sentences — no run ids, gate ids,
 *  or event names reach the person reading the timeline. */
import type { BotFeedEvent } from '../../lib/botSse'
import { toActivity, runTitle, type ApprovalGate, type RunDetail, type StreamEvent } from '@loop/loopit-client'
import { gateTitle, statusLabel } from '../../build/status'

function gateLine(gate: ApprovalGate): string {
  const sentence = gateTitle(gate.action)
  if (gate.status === 'approved') return 'Approved — the step went ahead'
  if (gate.status === 'rejected') return 'Declined — the step was stopped'
  return gate.reason ? `${sentence} — ${gate.reason}` : sentence
}

export function loopitDetailToFeed(run: RunDetail | null | undefined): BotFeedEvent[] {
  if (!run) return []
  const events: BotFeedEvent[] = [{
    type: 'status',
    message: run.summary ? `${statusLabel(run.status)} — ${run.summary}` : statusLabel(run.status),
  }]
  const gates = [...(run.gates ?? [])]
  if (run.gate && !gates.some((gate) => gate.gate_id === run.gate?.gate_id)) gates.push(run.gate)
  for (const gate of gates) {
    events.push({ type: 'status', message: gateLine(gate) })
  }
  const checkpoints = run.checkpoints ?? []
  checkpoints.forEach((checkpoint, index) => {
    events.push({
      type: 'artifact',
      artifact: { id: checkpoint.checkpoint_id, name: `Version ${index + 1}`, kind: 'file' },
    })
  })
  return events
}

export function loopitStreamToFeed(event: StreamEvent): BotFeedEvent | null {
  if (event.kind === 'audit') {
    const line = toActivity(event, 0)
    return {
      type: line.tone === 'bad' ? 'error' : 'status',
      message: line.body ? `${line.title} — ${line.body}` : line.title,
    }
  }
  if (event.kind === 'error') return { type: 'error', message: event.message }
  if (event.kind === 'gate') return { type: 'status', message: gateLine(event.gate) }
  if (event.kind === 'run') {
    const label = statusLabel(event.status)
    return { type: 'status', message: event.summary ? `${label} — ${event.summary}` : `${runTitle(event)}: ${label}` }
  }
  if (event.kind === 'checkpoints') {
    return { type: 'status', message: `Saved version ${event.checkpoints.length}` }
  }
  return null
}
