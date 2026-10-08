/** Map a Loop-IT run and its stream onto the bot run timeline feed. */
import type { BotFeedEvent } from '../../lib/botSse'
import { toActivity, type RunDetail, type StreamEvent } from '@loop/loopit-client'

export function loopitDetailToFeed(run: RunDetail | null | undefined): BotFeedEvent[] {
  if (!run) return []
  const events: BotFeedEvent[] = [{
    type: 'status',
    message: run.summary ? `${run.status} — ${run.summary}` : String(run.status || 'unknown'),
  }]
  const gates = [...(run.gates ?? [])]
  if (run.gate && !gates.some((gate) => gate.gate_id === run.gate?.gate_id)) gates.push(run.gate)
  for (const gate of gates) {
    events.push({
      type: 'status',
      message: `Gate ${gate.gate_id} (${gate.status || 'pending'}): ${gate.reason}`,
    })
  }
  for (const checkpoint of run.checkpoints ?? []) {
    events.push({
      type: 'artifact',
      artifact: { id: checkpoint.checkpoint_id, name: checkpoint.label || checkpoint.checkpoint_id, kind: 'file' },
    })
  }
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
  if (event.kind === 'gate') return { type: 'status', message: `Gate ${event.gate.gate_id}: ${event.gate.reason}` }
  if (event.kind === 'run') return { type: 'status', message: `Run ${event.run_id} is ${event.status}` }
  if (event.kind === 'checkpoints') {
    const count = event.checkpoints.length
    return { type: 'status', message: `${count} checkpoint${count === 1 ? '' : 's'}` }
  }
  return null
}
