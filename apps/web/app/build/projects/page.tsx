'use client'

import { Suspense, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Badge, EmptyState, LoadingState, SectionHeader, btnGhost, btnOutline, btnPrimary, cardCls, textareaCls } from '@loop/ui'
import {
  deleteProjectSecret,
  isServiceMissing,
  isUnreachable,
  listProjectSecrets,
  putProjectSecret,
  runTitle,
  setProjectVisibility,
  toUserFacingError,
  type EffortTier,
  type ProjectVisibility,
  type RunMode,
  type RunSummary,
} from '@loop/loopit-client'
import { AppPage } from '../../components/AppPage'
import { useToast } from '../../lib/toast'
import { BuildSessionRail } from '../SessionRail'
import { NotificationsBell } from '../NotificationsBell'
import { ErrorNotice } from '../shell'
import { formatWhen, statusLabel, statusTone } from '../status'
import { ModeSwitch } from '../ModeSwitch'
import { CostTransparencyBar, EffortEstimateNotice, EffortSwitch } from '../EffortSwitch'
import { BrowserRunSwitch } from '../../components/browser/BrowserRunSwitch'
import { AnalyticsPanel, CollaborationPanel, ConnectorsPanel } from '../Phase3Panels'
import { ProjectDomainsPanel, ProjectGitPanel } from './ProjectSyncPanels'
import {
  useArchiveProject,
  useBuildProject,
  useBuildProjects,
  useDuplicateProject,
  usePutProjectKnowledge,
  useRenameProject,
  useRestoreProject,
  useStartBuild,
} from '../hooks'
import {
  collectImageFiles,
  readPreview,
  uploadBuildImage,
  type BuildAttachment,
} from '../attachments'

function ProjectsFrame({
  title,
  description,
  back,
  actions,
  children,
}: {
  title: string
  description?: string
  back?: { href: string; label: string }
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <AppPage
      width="fill"
      title={title}
      description={description}
      back={back}
      rail={<BuildSessionRail activeRunId={null} />}
      actions={(
        <div className="flex items-center gap-2">
          <NotificationsBell />
          {actions}
        </div>
      )}
    >
      <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
    </AppPage>
  )
}

export default function BuildProjectsPage() {
  return (
    <Suspense fallback={<ProjectsFrame title="Build projects"><LoadingState variant="card" label="Loading projects" /></ProjectsFrame>}>
      <ProjectsRoute />
    </Suspense>
  )
}

function ProjectsRoute() {
  const id = useSearchParams().get('id')
  if (id) return <ProjectView key={id} projectId={id} />
  return <ProjectsBoard />
}

function ProjectsBoard() {
  const router = useRouter()
  const [showArchived, setShowArchived] = useState(false)
  const [undoId, setUndoId] = useState<string | null>(null)
  const projects = useBuildProjects(showArchived)
  const archive = useArchiveProject()
  const restore = useRestoreProject()
  const duplicate = useDuplicateProject()
  const toast = useToast()
  const list = projects.data ?? []
  const facing = projects.error ? toUserFacingError(projects.error) : null
  const offline = projects.error ? isUnreachable(projects.error) || isServiceMissing(projects.error) : false

  return (
    <ProjectsFrame
      title="Build projects"
      description="Continuous builds share one project workspace, preview, and project notes."
      back={{ href: '/build', label: 'All builds' }}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <label className="inline-flex items-center gap-2 text-ui-xs text-[var(--ink-secondary)]">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          Show archived
        </label>
      </div>
      {undoId && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2">
          <p className="text-ui-xs text-[var(--ink-secondary)]">Project archived.</p>
          <button
            type="button"
            className={btnOutline}
            disabled={restore.isPending}
            onClick={async () => {
              try {
                await restore.mutateAsync(undoId)
                setUndoId(null)
                toast.push('success', 'Project restored')
              } catch (cause) {
                toast.push('error', toUserFacingError(cause).message)
              }
            }}
          >
            Undo
          </button>
        </div>
      )}
      {facing && (
        <ErrorNotice
          error={offline ? {
            kind: 'unavailable',
            title: 'Build service unreachable',
            message: 'The Build service is not reachable.',
            action: 'Retry in a moment.',
          } : facing}
          onRetry={() => { void projects.refetch() }}
        />
      )}
      {projects.isPending && <LoadingState variant="card" label="Loading projects" />}
      {projects.isSuccess && list.length === 0 && (
        <EmptyState
          title="No projects yet"
          body="Start a build from the Build board — each run creates or continues a project."
          action={<Link href="/build" className="text-ui-xs text-[var(--accent-text)] hover:underline">Go to Build</Link>}
        />
      )}
      <div className="mt-3 space-y-2">
        {list.map((project) => (
          <div key={project.project_id} className={`p-3.5 ${cardCls}`}>
            <div className="flex items-start justify-between gap-3">
              <Link href={`/build/projects/?id=${encodeURIComponent(project.project_id)}`} className="min-w-0">
                <p className="text-ui-sm font-medium text-[var(--ink-primary)] truncate">{project.name}</p>
                <p className="mt-1 text-ui-xs text-[var(--ink-muted)]">
                  {project.run_count ?? 0} run{(project.run_count ?? 0) === 1 ? '' : 's'}
                  {project.updated_at ? ` · Updated ${formatWhen(project.updated_at)}` : ''}
                </p>
              </Link>
              {project.archived_at && <Badge tone="neutral">Archived</Badge>}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Link href={`/build/projects/?id=${encodeURIComponent(project.project_id)}`} className={btnGhost}>Open</Link>
              {!project.archived_at ? (
                <button
                  type="button"
                  className={btnGhost}
                  disabled={archive.isPending}
                  onClick={async () => {
                    try {
                      await archive.mutateAsync(project.project_id)
                      setUndoId(project.project_id)
                      toast.push('success', 'Project archived')
                    } catch (cause) {
                      toast.push('error', toUserFacingError(cause).message)
                    }
                  }}
                >
                  Archive
                </button>
              ) : (
                <button
                  type="button"
                  className={btnGhost}
                  disabled={restore.isPending}
                  onClick={async () => {
                    try {
                      await restore.mutateAsync(project.project_id)
                      toast.push('success', 'Project restored')
                    } catch (cause) {
                      toast.push('error', toUserFacingError(cause).message)
                    }
                  }}
                >
                  Restore
                </button>
              )}
              <button
                type="button"
                className={btnGhost}
                disabled={duplicate.isPending}
                onClick={async () => {
                  try {
                    const copy = await duplicate.mutateAsync(project.project_id)
                    toast.push('success', 'Project duplicated')
                    router.push(`/build/projects/?id=${encodeURIComponent(copy.project_id)}`)
                  } catch (cause) {
                    toast.push('error', toUserFacingError(cause).message)
                  }
                }}
              >
                Duplicate
              </button>
            </div>
          </div>
        ))}
      </div>
    </ProjectsFrame>
  )
}

function ProjectVisibilityPanel({
  projectId,
  visibility,
  shareId,
  title,
}: {
  projectId: string
  visibility: ProjectVisibility
  shareId?: string | null
  title: string
}) {
  const toast = useToast()
  const [value, setValue] = useState<ProjectVisibility>(visibility)
  const [share, setShare] = useState(shareId ?? '')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setValue(visibility)
    setShare(shareId ?? '')
  }, [visibility, shareId])

  return (
    <div className="pt-3 border-t border-[var(--border-subtle)] space-y-2">
      <SectionHeader title="Sharing" />
      <p className="text-3xs text-[var(--ink-muted)]">
        Private by default. Link shares a public page; Public remix also allows forking the latest checkpoint (no chat or secrets).
      </p>
      <div className="flex flex-wrap gap-2 items-center">
        <select
          className={`${textareaCls} py-2 w-auto`}
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value as ProjectVisibility)}
        >
          <option value="private">Private</option>
          <option value="link">Link</option>
          <option value="public_remix">Public remix</option>
        </select>
        <button
          type="button"
          className={btnPrimary}
          disabled={busy || value === visibility}
          onClick={async () => {
            setBusy(true)
            try {
              const result = await setProjectVisibility(projectId, value, title)
              setShare(result.share_id)
              toast.push('success', 'Visibility updated')
            } catch (cause) {
              toast.push('error', toUserFacingError(cause).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          Save
        </button>
        {share && value !== 'private' && (
          <Link href={`/build/share/?id=${encodeURIComponent(share)}`} className={btnGhost}>
            Open share page
          </Link>
        )}
      </div>
    </div>
  )
}

function ProjectSecretsPanel({ projectId }: { projectId: string }) {
  const toast = useToast()
  const [names, setNames] = useState<Array<{ name: string; status?: string; reason?: string }>>([])
  const [secretName, setSecretName] = useState('')
  const [secretValue, setSecretValue] = useState('')
  const [busy, setBusy] = useState(false)

  async function refresh() {
    try {
      setNames(await listProjectSecrets(projectId))
    } catch {
      setNames([])
    }
  }

  useEffect(() => { void refresh() }, [projectId])

  return (
    <div id="project-secrets" className="pt-3 border-t border-[var(--border-subtle)] space-y-2">
      <SectionHeader title="Secrets" />
      <p className="text-3xs text-[var(--ink-muted)]">
        Injected into sandbox and deploy env only — never into the client bundle. Use UPPER_SNAKE names (not VITE_).
      </p>
      <ul className="space-y-1">
        {names.map((item) => (
          <li key={item.name} className="flex items-center justify-between gap-2 text-ui-xs">
            <span>
              <code>{item.name}</code>
              {item.status === 'requested' && <span className="ml-2 text-[var(--accent-text)]">requested{item.reason ? `: ${item.reason}` : ''}</span>}
            </span>
            <button
              type="button"
              className={btnGhost}
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await deleteProjectSecret(projectId, item.name)
                  toast.push('success', 'Secret removed')
                  await refresh()
                } catch (cause) {
                  toast.push('error', toUserFacingError(cause).message)
                } finally {
                  setBusy(false)
                }
              }}
            >
              Remove
            </button>
          </li>
        ))}
        {names.length === 0 && <li className="text-3xs text-[var(--ink-muted)]">No secrets yet.</li>}
      </ul>
      <div className="flex flex-wrap gap-2">
        <input
          className={`${textareaCls} py-2 flex-1 min-w-[8rem]`}
          placeholder="API_KEY"
          value={secretName}
          onChange={(e) => setSecretName(e.target.value.toUpperCase())}
        />
        <input
          className={`${textareaCls} py-2 flex-[2] min-w-[10rem]`}
          placeholder="Paste value"
          type="password"
          value={secretValue}
          onChange={(e) => setSecretValue(e.target.value)}
        />
        <button
          type="button"
          className={btnPrimary}
          disabled={busy || !secretName.trim() || !secretValue}
          onClick={async () => {
            setBusy(true)
            try {
              await putProjectSecret(projectId, secretName.trim(), secretValue)
              setSecretName('')
              setSecretValue('')
              toast.push('success', 'Secret saved')
              await refresh()
            } catch (cause) {
              toast.push('error', toUserFacingError(cause).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          Save secret
        </button>
      </div>
    </div>
  )
}

function ProjectView({ projectId }: { projectId: string }) {
  const query = useBuildProject(projectId)
  const rename = useRenameProject()
  const knowledgeMut = usePutProjectKnowledge(projectId)
  const start = useStartBuild()
  const router = useRouter()
  const toast = useToast()
  const [name, setName] = useState('')
  const [knowledge, setKnowledge] = useState('')
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<RunMode>('build')
  const [tier, setTier] = useState<EffortTier>('standard')
  const [browserOn, setBrowserOn] = useState(false)
  const [browserDeviceId, setBrowserDeviceId] = useState('')
  const [attachments, setAttachments] = useState<BuildAttachment[]>([])
  const [hydrated, setHydrated] = useState(false)

  const project = query.data
  useEffect(() => {
    if (!project || hydrated) return
    setName(project.name || '')
    setKnowledge(project.knowledge || '')
    setHydrated(true)
  }, [project, hydrated])

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    const text = prompt.trim()
    if (!text || start.isPending) return
    const urls = attachments.filter((a) => a.status === 'done' && a.url).map((a) => a.url!)
    try {
      const created = await start.mutateAsync({
        prompt: text,
        projectId,
        mode,
        tier,
        attachmentUrls: urls,
        ...(browserOn ? { browser: true, browserDeviceId } : {}),
      })
      router.push(`/build/?run=${encodeURIComponent(created.run_id)}`)
    } catch {
      // mutation error notice
    }
  }

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

  if (query.isPending) {
    return <ProjectsFrame title="Project" back={{ href: '/build/projects', label: 'Build projects' }}><LoadingState variant="card" label="Loading project" /></ProjectsFrame>
  }
  if (query.isError || !project) {
    return (
      <ProjectsFrame title="Project" back={{ href: '/build/projects', label: 'Build projects' }}>
        <ErrorNotice error={toUserFacingError(query.error ?? new Error('Project not found'))} />
      </ProjectsFrame>
    )
  }

  const runs = (project.runs ?? []) as RunSummary[]

  return (
    <ProjectsFrame
      title={project.name}
      description="Builds in this project share the preview and project notes."
      back={{ href: '/build/projects', label: 'Build projects' }}
      actions={(
        <Link href="/build" className={btnOutline}>Builds</Link>
      )}
    >
      <section className={`${cardCls} p-4 space-y-3`}>
        <SectionHeader title="Settings" />
        <label className="block text-ui-xs text-[var(--ink-muted)]">
          Name
          <div className="mt-1.5 flex gap-2">
            <input
              className={`${textareaCls} py-2`}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              type="button"
              className={btnPrimary}
              disabled={rename.isPending || !name.trim() || name.trim() === project.name}
              onClick={async () => {
                try {
                  await rename.mutateAsync({ projectId, name: name.trim() })
                  toast.push('success', 'Renamed')
                } catch (cause) {
                  toast.push('error', toUserFacingError(cause).message)
                }
              }}
            >
              Save
            </button>
          </div>
        </label>
        <label className="block text-ui-xs text-[var(--ink-muted)]">
          LOOP.md (injected into every goal)
          <textarea
            className={`${textareaCls} mt-1.5 font-mono`}
            rows={5}
            value={knowledge ?? ''}
            onChange={(e) => setKnowledge(e.target.value)}
            placeholder="Stack preferences, brand rules, do-not-touch paths…"
          />
        </label>
        <button
          type="button"
          className={btnOutline}
          disabled={knowledgeMut.isPending}
          onClick={async () => {
            try {
              await knowledgeMut.mutateAsync(knowledge ?? '')
              toast.push('success', 'Knowledge saved')
            } catch (cause) {
              toast.push('error', toUserFacingError(cause).message)
            }
          }}
        >
          Save LOOP.md
        </button>
        <ProjectSecretsPanel projectId={projectId} />
        <ProjectVisibilityPanel
          projectId={projectId}
          visibility={(project.visibility as ProjectVisibility | undefined) ?? 'private'}
          shareId={project.share_id}
          title={project.name}
        />
        <ProjectGitPanel projectId={projectId} checkpointId={project?.current_checkpoint_id ?? null} />
        <ProjectDomainsPanel projectId={projectId} />
        <ConnectorsPanel projectId={projectId} />
        <AnalyticsPanel projectId={projectId} />
        <CollaborationPanel projectId={projectId} />
      </section>

      <form onSubmit={(e) => { void onSubmit(e) }} className={`${cardCls} mt-4 p-4 space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionHeader title="Continue this project" />
          <div className="flex flex-wrap items-center gap-2">
            <EffortSwitch value={tier} onChange={setTier} disabled={start.isPending} />
            <BrowserRunSwitch enabled={browserOn} deviceId={browserDeviceId} onEnabled={setBrowserOn} onDevice={setBrowserDeviceId} disabled={start.isPending} compact />
            <ModeSwitch value={mode} onChange={setMode} disabled={start.isPending} />
          </div>
        </div>
        <CostTransparencyBar tier={tier} />
        <EffortEstimateNotice tier={tier} mode={mode} />
        <textarea
          className={textareaCls}
          rows={3}
          value={prompt}
          disabled={start.isPending}
          placeholder={mode === 'chat' ? 'Ask about this project…' : mode === 'plan' ? 'Describe what to plan…' : 'What should we change next?'}
          onChange={(e) => setPrompt(e.target.value)}
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
        <p className="text-3xs text-[var(--ink-muted)]">Paste or drop images to attach. They are sent with the build as links.</p>
        <div className="flex justify-end">
          <button type="submit" className={btnPrimary} disabled={start.isPending || !prompt.trim()}>
            {start.isPending ? 'Starting…' : mode === 'chat' ? 'Ask' : mode === 'plan' ? 'Draft plan' : 'Continue build'}
          </button>
        </div>
        {start.isError && <ErrorNotice error={toUserFacingError(start.error)} />}
      </form>

      <div className="mt-6">
        <SectionHeader title="Builds" count={runs.length} />
        <div className="mt-3 space-y-2">
          {runs.length === 0 && <EmptyState title="No builds yet" body="Start a build above." />}
          {runs.map((run) => (
            <Link key={run.run_id} href={`/build/?run=${encodeURIComponent(run.run_id)}`} className={`block p-3.5 ${cardCls}`}>
              <div className="flex items-start justify-between gap-3">
                <p className="text-ui-sm font-medium text-[var(--ink-primary)] line-clamp-2">{runTitle(run)}</p>
                <Badge tone={statusTone(run.status)}>{statusLabel(run.status)}</Badge>
              </div>
              {run.mode && <p className="mt-1 text-3xs text-[var(--ink-muted)] capitalize">{run.mode} mode</p>}
              <p className="mt-1 text-ui-xs text-[var(--ink-muted)]">Created {formatWhen(run.started_at)}</p>
            </Link>
          ))}
        </div>
      </div>
    </ProjectsFrame>
  )
}
