'use client'

import { Suspense, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import RunView from './[runId]/RunView'
import { Badge, EmptyState, SectionHeader, Skeleton, btnPrimary, inputCls } from '@loop/ui'
import { isServiceMissing, isUnreachable, toUserFacingError, type RunSummary } from '@loop/loopit-client'
import { useBuildRuns, useStartBuild } from './hooks'
import { BuildShell, ErrorNotice } from './shell'

const SAMPLES = [
  'Build a customer intake form with an admin review table.',
  'Create a landing page with pricing cards and a waitlist form.',
  'Build a team task tracker with projects and owner-only settings.',
]

export default function BuildPage() {
  return (
    <Suspense fallback={<BuildShell><div role="status" aria-label="Loading builds"><Skeleton variant="card" /></div></BuildShell>}>
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
  const [effort, setEffort] = useState(12)
  const list = runs.data ?? []

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    const text = prompt.trim()
    if (!text || start.isPending) return
    try {
      const created = await start.mutateAsync({ prompt: text, maxIterations: effort })
      router.push(`/build/?run=${encodeURIComponent(created.run_id)}`)
    } catch {
      // The mutation records the error; the notice under the form renders it.
    }
  }

  const listError = runs.error
  const facing = listError ? toUserFacingError(listError) : null
  const offline = listError ? isUnreachable(listError) || isServiceMissing(listError) : false

  return (
    <BuildShell>
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Builds</h1>
          <p className="mt-1 text-sm text-[var(--ink-secondary)]">Describe an app. Loop builds, verifies, and previews it.</p>
        </div>
      </div>

      <form onSubmit={(event) => { void onSubmit(event) }} className="mt-5 space-y-3">
        <label className="block text-xs text-[var(--ink-muted)]">
          Prompt
          <textarea
            className={`${inputCls} mt-1`}
            rows={3}
            value={prompt}
            placeholder="Describe what you want built"
            aria-label="Build prompt"
            disabled={start.isPending}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={btnPrimary} disabled={start.isPending || !prompt.trim()}>
            {start.isPending ? 'Starting…' : 'Start build'}
          </button>
          <label className="text-xs text-[var(--ink-muted)]">
            Effort
            <select
              aria-label="Maximum agent iterations"
              className="ml-2 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-sunken)] px-2 py-1.5 text-sm text-[var(--ink-primary)]"
              value={effort}
              disabled={start.isPending}
              onChange={(event) => setEffort(Number(event.target.value))}
            >
              <option value={8}>Quick (8)</option>
              <option value={12}>Normal (12)</option>
              <option value={24}>Deep (24)</option>
              <option value={40}>Max (40)</option>
            </select>
          </label>
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
          {runs.isPending && (
            <div role="status" aria-label="Loading builds">
              <Skeleton variant="card" />
            </div>
          )}
          {facing && (
            <ErrorNotice
              error={offline ? {
                kind: 'unavailable',
                title: 'Build service unreachable',
                message: 'The build API is not reachable. It may not be deployed yet.',
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
                    <button key={sample} type="button" className="text-left text-xs text-[var(--accent-text)]" onClick={() => setPrompt(sample)}>
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
    </BuildShell>
  )
}

function RunRow({ run }: { run: RunSummary }) {
  return (
    <Link
      href={`/build/?run=${encodeURIComponent(run.run_id)}`}
      className="block rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-3.5 hover:border-[var(--border-strong)]"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium line-clamp-2">{run.prompt || 'Untitled build'}</p>
        <Badge tone={statusTone(run.status)}>{run.status}</Badge>
      </div>
      <p className="mt-1 text-xs text-[var(--ink-muted)]">Created {formatWhen(run.started_at)}</p>
    </Link>
  )
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

function statusTone(status: string): 'neutral' | 'accent' | 'green' | 'amber' | 'rose' {
  const value = status.toLowerCase()
  if (value === 'verified' || value === 'merged' || value === 'completed' || value === 'success') return 'green'
  if (value === 'error' || value === 'failed') return 'rose'
  if (value === 'running' || value === 'verifying') return 'accent'
  if (value === 'blocked' || value === 'pending') return 'amber'
  return 'neutral'
}
