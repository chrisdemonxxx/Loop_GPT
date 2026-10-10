'use client'

/** Chat card for a Build run linked on the conversation. Events render in
 *  the same timeline used by bot runs; the full run opens at /build. */
import { useState } from 'react'
import Link from 'next/link'
import { Badge, linkCls } from '@loop/ui'
import { runTitle, type StreamEvent } from '@loop/loopit-client'
import { useBuildRun, useRunStream } from '../../build/hooks'
import { isLiveStatus, statusLabel, statusTone } from '../../build/status'
import { RunTimeline } from '../team-bot/RunTimeline'
import { loopitDetailToFeed, loopitStreamToFeed } from '../team-bot/loopitTimeline'

export function LoopitRunCard({ runId }: { runId: string }) {
  const query = useBuildRun(runId)
  const [live, setLive] = useState<StreamEvent[]>([])
  const status = query.data?.status
  useRunStream(runId, isLiveStatus(status), (event) => {
    setLive((prev) => [...prev, event].slice(-200))
  })
  const streamed = live.map(loopitStreamToFeed).filter((event): event is NonNullable<typeof event> => !!event)
  const events = [...loopitDetailToFeed(query.data), ...streamed]
  const href = `/build/?run=${encodeURIComponent(runId)}`
  return (
    <div data-testid="loopit-run-card" className="mb-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-ui-sm text-[var(--ink-primary)]">
          {/* The run goes by its brief title, never its internal id. */}
          <span className="truncate">{query.data ? runTitle(query.data) : 'Build'}</span>
          {status && <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>}
        </div>
        <Link href={href} className={`shrink-0 text-ui-xs ${linkCls}`}>Open build</Link>
      </div>
      <RunTimeline events={events} status={isLiveStatus(status) ? 'running' : undefined} compact />
    </div>
  )
}
