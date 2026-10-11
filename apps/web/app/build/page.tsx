'use client'

import { Suspense, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import RunView from './[runId]/RunView'
import { Badge, EmptyState, LoadingState, SectionHeader, btnPrimary, cardCls, textareaCls } from '@loop/ui'
import { isServiceMissing, isUnreachable, runTitle, toUserFacingError, type RunSummary } from '@loop/loopit-client'
import { AppPage } from '../components/AppPage'
import { useBuildRuns, useStartBuild } from './hooks'
import { ErrorNotice } from './shell'
import { formatWhen, statusLabel, statusTone } from './status'
import type { RunTier } from '@loop/loopit-client'

const SAMPLES = [
  'A customer intake form with an admin review table.',
  'A landing page with pricing cards and a waitlist form.',
  'A team task tracker with projects.',
]

export default function BuildPage() {
  return (
    <Suspense fallback={<AppPage title="Build"><LoadingState variant="card" label="Loading builds" /></AppPage>}>
      <BuildRoute />
    </Suspense>
  )
}

function BuildRoute() {
  const selected = useSearchParams().get('run')
  if (selected) return <RunView runId={selected} />
  return <BuildBoard />
}

function BuildBoard() {
  const router = useRouter()
  const runs = useBuildRuns()
  const start = useStartBuild()
  const [prompt, setPrompt] = useState('')
  const [tier, setTier] = useState<RunTier>('standard')
  const list = runs.data ?? []

  // The engine owns everything past this box: it expands the request into a
  // brief, sizes the effort itself, builds, and stops when it is done.
  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    const text = prompt.trim()
    if (!text || start.isPending) return
    try {
      const created = await start.mutateAsync({ prompt: text, tier })
      router.push(`/build/?run=${encodeURIComponent(created.run_id)}`)
    } catch {
      // The mutation records the error; the notice under the form renders it.
    }
  }

  const listError = runs.error
  const facing = listError ? toUserFacingError(listError) : null
  const offline = listError ? isUnreachable(listError) || isServiceMissing(listError) : false

  return (
    <AppPage title="Build" description="Describe an app in your own words. Loop plans it, builds it, and verifies it.">
      <form onSubmit={(event) => { void onSubmit(event) }} className={`${cardCls} p-4 space-y-3`}>
        <label className="block text-ui-xs text-[var(--ink-muted)]">
          What should we build?
          <textarea
            className={`${textareaCls} mt-1.5`}
            rows={3}
            value={prompt}
            placeholder="A customer intake form with an admin review table — or just “build this”"
            disabled={start.isPending}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void onSubmit(event as unknown as FormEvent) } }}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {SAMPLES.map((sample) => (
            <button
              key={sample}
              type="button"
              onClick={() => setPrompt(sample)}
              className="rounded-full border border-[var(--border-subtle)] bg-[var(--bg-tint)] px-3 py-1 text-2xs text-[var(--ink-secondary)] hover:border-[var(--accent-soft-border)] hover:text-[var(--accent-text)] transition"
            >
              {sample}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <TierSelect value={tier} onChange={setTier} />
            <p className="text-2xs text-[var(--ink-muted)]">Plans, builds, verifies and previews — then publishes with one click. ⌘/Ctrl+Enter to start.</p>
          </div>
          <button type="submit" className={btnPrimary} disabled={start.isPending || !prompt.trim()}>
            {start.isPending ? 'Starting…' : 'Start build'}
          </button>
        </div>
      </form>

      {start.isError && (
        <div className="mt-4">
          <ErrorNotice error={toUserFacingError(start.error)} />
        </div>
      )}

      <div className="mt-8">
        <SectionHeader title="Your builds" count={runs.isSuccess ? list.length : null} />
        <div className="mt-3 space-y-2">
          {runs.isPending && <LoadingState variant="card" label="Loading builds" />}
          {facing && (
            <ErrorNotice
              error={offline ? {
                kind: 'unavailable',
                title: 'Build service unreachable',
                message: 'The Build service is not reachable. It may not be deployed yet.',
                action: 'Retry in a moment. Your other Loop pages keep working.',
              } : facing}
              onRetry={() => { void runs.refetch() }}
            />
          )}
          {runs.isSuccess && list.length === 0 && (
            <EmptyState
              title="No builds yet"
              body="Start with a prompt above, or use one of these."
              action={(
                <div className="flex flex-col gap-2">
                  {SAMPLES.map((sample) => (
                    <button key={sample} type="button" className="text-left text-ui-xs text-[var(--accent-text)] hover:underline" onClick={() => setPrompt(sample)}>
                      {sample}
                    </button>
                  ))}
                </div>
              )}
            />
          )}
          {runs.isSuccess && list.map((run) => <RunRow key={run.run_id} run={run} />)}
        </div>
      </div>
    </AppPage>
  )
}

function RunRow({ run }: { run: RunSummary }) {
  return (
    <Link href={`/build/?run=${encodeURIComponent(run.run_id)}`} className={`block p-3.5 ${cardCls}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-ui-sm font-medium text-[var(--ink-primary)] line-clamp-2">{runTitle(run)}</p>
        <Badge tone={statusTone(run.status)}>{statusLabel(run.status)}</Badge>
      </div>
      {run.summary && <p className="mt-1 line-clamp-1 text-ui-xs text-[var(--ink-muted)]">{run.summary}</p>}
      <p className="mt-1 text-ui-xs text-[var(--ink-muted)]">Created {formatWhen(run.started_at)}</p>
    </Link>
  )
}

const TIER_LABELS: Record<RunTier, string> = {
  quick: 'Quick',
  standard: 'Standard',
  deep: 'Deep',
  max: 'Max',
}

const TIER_HINTS: Record<RunTier, string> = {
  quick: '8 iters — small edits, fixes',
  standard: '14 iters — most apps',
  deep: '24 iters — complex flows',
  max: '40 iters — big refactors',
}

function TierSelect({ value, onChange }: { value: RunTier; onChange: (tier: RunTier) => void }) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor="tier" className="text-2xs text-[var(--ink-muted)]">Effort</label>
      <select
        id="tier"
        value={value}
        onChange={(e) => onChange(e.target.value as RunTier)}
        className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1 text-2xs text-[var(--ink-secondary)] focus:border-[var(--accent-soft-border)] focus:outline-none"
      >
        {(Object.keys(TIER_LABELS) as RunTier[]).map((tier) => (
          <option key={tier} value={tier}>{TIER_LABELS[tier]} — {TIER_HINTS[tier]}</option>
        ))}
      </select>
    </div>
  )
}
