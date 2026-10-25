'use client'

import { Suspense, useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import RunView from './[runId]/RunView'
import { LoadingState, btnOutline, btnPrimary, cardCls, textareaCls } from '@loop/ui'
import { toUserFacingError, type EffortTier, type RunMode } from '@loop/loopit-client'
import { AppPage } from '../components/AppPage'
import { useStartBuild } from './hooks'
import { ErrorNotice } from './shell'
import { BuildSessionRail } from './SessionRail'
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
  const params = useSearchParams()
  const start = useStartBuild()
  const seededPrompt = params.get('prompt') ?? ''
  const [prompt, setPrompt] = useState(seededPrompt)
  useEffect(() => {
    if (seededPrompt) setPrompt(seededPrompt)
  }, [seededPrompt])
  const [mode, setMode] = useState<RunMode>('build')
  const [tier, setTier] = useState<EffortTier>('standard')
  const [attachments, setAttachments] = useState<BuildAttachment[]>([])

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

  return (
    <AppPage
      width="fill"
      title="Build"
      description="Describe an app in your own words. Loop plans it, builds it, and verifies it."
      rail={<BuildSessionRail activeRunId={null} />}
      actions={(
        <div className="flex items-center gap-2">
          <NotificationsBell />
          <Link href="/build/templates" className={btnOutline}>Templates</Link>
          <Link href="/build/projects" className={btnOutline}>Build projects</Link>
        </div>
      )}
    >
      <form onSubmit={(event) => { void onSubmit(event) }} className={`${cardCls} max-w-3xl p-4 space-y-3`}>
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
          placeholder={mode === 'chat' ? 'Ask a question to start a new read-only run…' : mode === 'plan' ? 'Describe what to plan…' : 'A customer intake form with an admin review table — or just “build this”'}
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
            {mode === 'chat' ? 'Chat mode starts a new read-only run. Open a build project to ask about one that already exists.' : mode === 'plan' ? 'Plan mode drafts a task list you can approve before building.' : 'Builds, verifies and previews — then you can publish. Paste images to attach. ⌘/Ctrl+Enter to start.'}
          </p>
          <button type="submit" className={btnPrimary} disabled={start.isPending || !prompt.trim()}>
            {start.isPending ? 'Starting…' : mode === 'chat' ? 'Start chat' : mode === 'plan' ? 'Draft plan' : 'Start build'}
          </button>
        </div>
      </form>

      {start.isError && (
        <div className="mt-4 max-w-3xl">
          <ErrorNotice error={toUserFacingError(start.error)} />
        </div>
      )}
    </AppPage>
  )
}
