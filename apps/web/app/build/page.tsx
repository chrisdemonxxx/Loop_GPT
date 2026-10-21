'use client'

import { Suspense, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import RunView from './[runId]/RunView'
import { Badge, EmptyState, LoadingState, SectionHeader, btnOutline, btnPrimary, cardCls, textareaCls } from '@loop/ui'
import { isServiceMissing, isUnreachable, runTitle, toUserFacingError, type EffortTier, type RunMode, type RunSummary } from '@loop/loopit-client'
import { AppPage } from '../components/AppPage'
import { useBuildRuns, useStartBuild } from './hooks'
import { ErrorNotice } from './shell'
import { formatWhen, statusLabel, statusTone } from './status'
import { ModeSwitch } from './ModeSwitch'
import { CostTransparencyBar, EffortEstimateNotice, EffortSwitch } from './EffortSwitch'
import { NotificationsBell } from './NotificationsBell'
import { collectImageFiles, readPreview, uploadBuildImage, type BuildAttachment } from './attachments'

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
  // Keyed so switching builds remounts: stream de-dupe, chat and tab state
  // all belong to one run and must not leak into the next.
  if (selected) return <RunView key={selected} runId={selected} />
  return <BuildBoard />
}

function BuildBoard() {
  const router = useRouter()
  const runs = useBuildRuns()
  const start = useStartBuild()
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<RunMode>('build')
  const [tier, setTier] = useState<EffortTier>('standard')
  const [attachments, setAttachments] = useState<BuildAttachment[]>([])
  const list = runs.data ?? []

  async function addImages(files: File[]) {
    for (const file of files) {
      const id = `att-${Date.now()}-${file.name}`
      let previewUrl: string | undefined
      try { previewUrl = await readPreview(file) } catch { /* ignore */ }
      setAttachments((prev) => [...prev, { id, name: file.name, previewUrl, status: 'uploading' }])
      try {
        const uploaded = await uploadBuildImage(file)
        setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, status: 'done', url: uploaded.url } : a)))
      } catch (cause) {
        setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, status: 'error', error: cause instanceof Error ? cause.message : 'Upload failed' } : a)))
      }
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    const text = prompt.trim()
    if (!text || start.isPending) return
    const urls = attachments.filter((a) => a.status === 'done' && a.url).map((a) => a.url!)
    try {
      const created = await start.mutateAsync({ prompt: text, mode, tier, attachmentUrls: urls })
      router.push(`/build/?run=${encodeURIComponent(created.run_id)}`)
    } catch {
      // The mutation records the error; the notice under the form renders it.
    }
  }

  const listError = runs.error
  const facing = listError ? toUserFacingError(listError) : null
  const offline = listError ? isUnreachable(listError) || isServiceMissing(listError) : false

  return (
    <AppPage
      title="Build"
      description="Describe an app in your own words. Loop plans it, builds it, and verifies it."
      actions={(
        <div className="flex items-center gap-2">
          <NotificationsBell />
          <Link href="/build/templates" className={btnOutline}>Templates</Link>
          <Link href="/build/projects" className={btnOutline}>Projects</Link>
        </div>
      )}
    >
      <form onSubmit={(event) => { void onSubmit(event) }} className={`${cardCls} p-4 space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="text-ui-xs text-[var(--ink-muted)]">What should we build?</label>
          <div className="flex flex-wrap items-center gap-2">
            <EffortSwitch value={tier} onChange={setTier} disabled={start.isPending} />
            <ModeSwitch value={mode} onChange={setMode} disabled={start.isPending} />
          </div>
        </div>
        <CostTransparencyBar tier={tier} />
        <EffortEstimateNotice tier={tier} mode={mode} />
        <textarea
          className={textareaCls}
          rows={3}
          value={prompt}
          placeholder={mode === 'chat' ? 'Ask about an existing project…' : mode === 'plan' ? 'Describe what to plan…' : 'A customer intake form with an admin review table — or just “build this”'}
          disabled={start.isPending}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void onSubmit(event as unknown as FormEvent) } }}
          onPaste={(e) => {
            const files = collectImageFiles(e.clipboardData)
            if (files.length) { e.preventDefault(); void addImages(files) }
          }}
          onDrop={(e) => {
            const files = collectImageFiles(e.dataTransfer)
            if (files.length) { e.preventDefault(); void addImages(files) }
          }}
        />
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((a) => (
              <span key={a.id} className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-subtle)] px-2 py-1 text-3xs">
                {a.previewUrl && <img src={a.previewUrl} alt="" className="h-6 w-6 rounded object-cover" />}
                {a.name}
                {a.status === 'uploading' && '…'}
                {a.status === 'error' && <span className="text-[var(--danger)]">{a.error}</span>}
                <button type="button" className="text-[var(--ink-muted)]" onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}>×</button>
              </span>
            ))}
          </div>
        )}
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
        <div className="flex items-center justify-between gap-3">
          <p className="text-2xs text-[var(--ink-muted)]">
            {mode === 'chat' ? 'Chat mode is read-only.' : mode === 'plan' ? 'Plan mode drafts a local task list (DAG execution needs orchestrator).' : 'Builds, verifies and previews — then you can publish. Paste images to attach. ⌘/Ctrl+Enter to start.'}
          </p>
          <button type="submit" className={btnPrimary} disabled={start.isPending || !prompt.trim()}>
            {start.isPending ? 'Starting…' : mode === 'chat' ? 'Start chat' : mode === 'plan' ? 'Draft plan' : 'Start build'}
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
