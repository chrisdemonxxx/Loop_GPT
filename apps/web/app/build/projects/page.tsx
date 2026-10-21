'use client'

import { Suspense, useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Badge, EmptyState, LoadingState, SectionHeader, btnGhost, btnOutline, btnPrimary, cardCls, textareaCls } from '@loop/ui'
import {
  bindGitRemote,
  claimProjectDomain,
  deleteProjectSecret,
  getGitStatus,
  isServiceMissing,
  isUnreachable,
  listProjectDomains,
  listProjectSecrets,
  putProjectSecret,
  runTitle,
  setProjectVisibility,
  toUserFacingError,
  verifyProjectDomain,
  type DomainClaim,
  type EffortTier,
  type GitSyncStatus,
  type ProjectVisibility,
  type RunMode,
  type RunSummary,
} from '@loop/loopit-client'
import { AppPage } from '../../components/AppPage'
import { useToast } from '../../lib/toast'
import { ErrorNotice } from '../shell'
import { formatWhen, statusLabel, statusTone } from '../status'
import { ModeSwitch } from '../ModeSwitch'
import { CostTransparencyBar, EffortEstimateNotice, EffortSwitch } from '../EffortSwitch'
import { AnalyticsPanel, CollaborationPanel, ConnectorsPanel } from '../Phase3Panels'
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

export default function BuildProjectsPage() {
  return (
    <Suspense fallback={<AppPage title="Projects"><LoadingState variant="card" label="Loading projects" /></AppPage>}>
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
  const projects = useBuildProjects()
  const archive = useArchiveProject()
  const restore = useRestoreProject()
  const duplicate = useDuplicateProject()
  const toast = useToast()
  const list = projects.data ?? []
  const facing = projects.error ? toUserFacingError(projects.error) : null
  const offline = projects.error ? isUnreachable(projects.error) || isServiceMissing(projects.error) : false

  return (
    <AppPage
      title="Projects"
      description="Continuous builds share one project workspace, preview, and LOOP.md knowledge."
      back={{ href: '/build', label: 'All builds' }}
    >
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
                      toast.push('success', 'Project archived (restore within 30 days)')
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
                    window.location.href = `/build/projects/?id=${encodeURIComponent(copy.project_id)}`
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
    </AppPage>
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

function ProjectGitPanel({ projectId }: { projectId: string }) {
  const toast = useToast()
  const [status, setStatus] = useState<GitSyncStatus | null>(null)
  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')
  const [busy, setBusy] = useState(false)

  async function refresh() {
    try {
      setStatus(await getGitStatus(projectId))
    } catch {
      setStatus({ bound: false })
    }
  }

  useEffect(() => { void refresh() }, [projectId])

  return (
    <div className="pt-3 border-t border-[var(--border-subtle)] space-y-2">
      <SectionHeader title="GitHub sync" />
      <p className="text-3xs text-[var(--ink-muted)]">
        Two-way sync via gitsync. Offline uses a fake provider; live needs LOOPIT_GITHUB_TOKEN or the Loop-GPT GitHub connector vault.
        Verified checkpoints auto-push when bound. Pull webhooks create a new checkpoint (conflicts → backup branch).
      </p>
      {status?.bound ? (
        <p className="text-ui-xs">
          Bound to <code>{status.owner}/{status.name}</code>
          {status.last_commit_sha ? ` · ${status.last_commit_sha.slice(0, 8)}` : ''}
          {status.mode ? ` · ${status.mode}` : ''}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <input className={`${textareaCls} py-2 flex-1 min-w-[8rem]`} placeholder="owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
          <input className={`${textareaCls} py-2 flex-1 min-w-[8rem]`} placeholder="repo" value={repo} onChange={(e) => setRepo(e.target.value)} />
          <button
            type="button"
            className={btnPrimary}
            disabled={busy || !owner.trim() || !repo.trim()}
            onClick={async () => {
              setBusy(true)
              try {
                await bindGitRemote(projectId, owner.trim(), repo.trim())
                toast.push('success', 'Repository bound')
                await refresh()
              } catch (cause) {
                toast.push('error', toUserFacingError(cause).message)
              } finally {
                setBusy(false)
              }
            }}
          >
            Bind
          </button>
        </div>
      )}
    </div>
  )
}

function ProjectDomainsPanel({ projectId }: { projectId: string }) {
  const toast = useToast()
  const [claims, setClaims] = useState<DomainClaim[]>([])
  const [hostname, setHostname] = useState('')
  const [busy, setBusy] = useState(false)

  async function refresh() {
    try {
      setClaims(await listProjectDomains(projectId))
    } catch {
      setClaims([])
    }
  }

  useEffect(() => { void refresh() }, [projectId])

  return (
    <div className="pt-3 border-t border-[var(--border-subtle)] space-y-2">
      <SectionHeader title="Domains" />
      <p className="text-3xs text-[var(--ink-muted)]">
        Connect a custom domain with a TXT ownership challenge (CNAME to the apps base). Offline verify seeds the fake resolver; live uses services/domains + TLS seam. Verified domains meter customDomainMonths when LOOPIT_USAGE_URL is set.
      </p>
      <ul className="space-y-2">
        {claims.map((claim) => (
          <li key={claim.claim_id} className="text-ui-xs space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <code>{claim.hostname}</code>
              <Badge tone={claim.status === 'verified' ? 'green' : 'neutral'}>{claim.status}</Badge>
              {claim.tls_status && <span className="text-[var(--ink-muted)]">TLS {claim.tls_status}</span>}
            </div>
            {claim.status !== 'verified' && (
              <>
                <p className="text-3xs text-[var(--ink-muted)] font-mono">
                  TXT {claim.challenge_name} = {claim.challenge_value}
                </p>
                <button
                  type="button"
                  className={btnGhost}
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      await verifyProjectDomain(projectId, claim.hostname, true)
                      toast.push('success', 'Domain verified')
                      await refresh()
                    } catch (cause) {
                      toast.push('error', toUserFacingError(cause).message)
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  Verify
                </button>
              </>
            )}
          </li>
        ))}
        {claims.length === 0 && <li className="text-3xs text-[var(--ink-muted)]">No custom domains yet.</li>}
      </ul>
      <div className="flex flex-wrap gap-2">
        <input
          className={`${textareaCls} py-2 flex-1 min-w-[12rem]`}
          placeholder="app.example.com"
          value={hostname}
          onChange={(e) => setHostname(e.target.value)}
        />
        <button
          type="button"
          className={btnPrimary}
          disabled={busy || !hostname.trim()}
          onClick={async () => {
            setBusy(true)
            try {
              await claimProjectDomain(projectId, hostname.trim())
              setHostname('')
              toast.push('success', 'Domain claimed — add the TXT record')
              await refresh()
            } catch (cause) {
              toast.push('error', toUserFacingError(cause).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          Connect domain
        </button>
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
    <div className="pt-3 border-t border-[var(--border-subtle)] space-y-2">
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
    return <AppPage title="Project" back={{ href: '/build/projects', label: 'Projects' }}><LoadingState variant="card" label="Loading project" /></AppPage>
  }
  if (query.isError || !project) {
    return (
      <AppPage title="Project" back={{ href: '/build/projects', label: 'Projects' }}>
        <ErrorNotice error={toUserFacingError(query.error ?? new Error('Project not found'))} />
      </AppPage>
    )
  }

  const runs = (project.runs ?? []) as RunSummary[]

  return (
    <AppPage
      title={project.name}
      description="Runs are turns in this project. Preview and LOOP.md stay with the workspace."
      back={{ href: '/build/projects', label: 'Projects' }}
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
        <ProjectGitPanel projectId={projectId} />
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
        <p className="text-3xs text-[var(--ink-muted)]">Paste or drop images to attach (vision routing deferred — URLs are passed as text).</p>
        <div className="flex justify-end">
          <button type="submit" className={btnPrimary} disabled={start.isPending || !prompt.trim()}>
            {start.isPending ? 'Starting…' : mode === 'chat' ? 'Ask' : mode === 'plan' ? 'Draft plan' : 'Continue build'}
          </button>
        </div>
        {start.isError && <ErrorNotice error={toUserFacingError(start.error)} />}
      </form>

      <div className="mt-6">
        <SectionHeader title="Turns" count={runs.length} />
        <div className="mt-3 space-y-2">
          {runs.length === 0 && <EmptyState title="No runs yet" body="Start a turn above." />}
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
    </AppPage>
  )
}
