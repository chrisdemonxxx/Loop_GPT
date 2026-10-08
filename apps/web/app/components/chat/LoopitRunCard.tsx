'use client'

/** Chat card for a Loop-IT build linked on the conversation. Events render
 *  in the same timeline used by bot runs, and the preview opens at /build. */
import { useState } from 'react'
import Link from 'next/link'
import type { StreamEvent } from '@loop/loopit-client'
import { useBuildRun, useRunStream } from '../../build/hooks'
import { RunTimeline } from '../team-bot/RunTimeline'
import { loopitDetailToFeed, loopitStreamToFeed } from '../team-bot/loopitTimeline'

const LIVE = new Set(['queued', 'running', 'awaiting_approval', 'awaiting_gate', 'verifying', 'checkpointing'])

export function LoopitRunCard({ runId }: { runId: string }) {
  const query = useBuildRun(runId)
  const [live, setLive] = useState<StreamEvent[]>([])
  const status = query.data?.status
  useRunStream(runId, typeof status === 'string' && LIVE.has(status), (event) => {
    setLive((prev) => [...prev, event].slice(-200))
  })
  const streamed = live.map(loopitStreamToFeed).filter((event): event is NonNullable<typeof event> => !!event)
  const events = [...loopitDetailToFeed(query.data), ...streamed]
  const href = `/build/?run=${encodeURIComponent(runId)}`
  return (
    <div data-testid="loopit-run-card" className="mb-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0 text-[13px] text-slate-200">
          Loop-IT build <span className="font-mono text-[11px] text-slate-400">{runId}</span>
        </div>
        <Link href={href} className="shrink-0 text-[12px] text-[#e79d7f] hover:underline">Open preview</Link>
      </div>
      <RunTimeline events={events} status={status === 'running' ? 'running' : undefined} compact />
    </div>
  )
}
