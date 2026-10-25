'use client'

import { useEffect, useState } from 'react'
import { Badge, SectionHeader, btnGhost, btnPrimary, textareaCls } from '@loop/ui'
import {
  bindGitRemote,
  claimProjectDomain,
  getGitStatus,
  listProjectDomains,
  pullGitWebhook,
  pushGitCheckpoint,
  toUserFacingError,
  unbindGitRemote,
  verifyProjectDomain,
  type DomainClaim,
  type GitSyncStatus,
} from '@loop/loopit-client'
import { useToast } from '../../lib/toast'
import { gitsyncProvider } from '../githubSync'
import { useBuildHealth } from '../hooks'

export function ProjectGitPanel({ projectId, checkpointId = null }: { projectId: string; checkpointId?: string | null }) {
  const toast = useToast()
  const health = useBuildHealth()
  const [status, setStatus] = useState<GitSyncStatus | null>(null)
  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const provider = (gitsyncProvider(health.data) ?? '').trim().toLowerCase()
  const disconnected = health.isFetched && (!provider || provider === 'fake')

  async function refresh() {
    try {
      setStatus(await getGitStatus(projectId))
      setError(null)
    } catch (cause) {
      setStatus(null)
      setError(toUserFacingError(cause).message)
    }
  }

  useEffect(() => { void refresh() }, [projectId])

  function report(cause: unknown) {
    const message = toUserFacingError(cause).message
    setError(message)
    toast.push('error', message)
  }

  return (
    <div className="pt-3 border-t border-[var(--border-subtle)] space-y-2">
      <SectionHeader title="GitHub sync" />
      {!health.isFetched ? (
        <p className="text-3xs text-[var(--ink-muted)]">Checking GitHub sync…</p>
      ) : disconnected ? (
        <>
          <p className="text-3xs text-[var(--ink-muted)]">GitHub sync is not connected.</p>
          <div className="flex flex-wrap gap-2">
            <input className={`${textareaCls} py-2 flex-1 min-w-[8rem]`} placeholder="owner" value="" disabled />
            <input className={`${textareaCls} py-2 flex-1 min-w-[8rem]`} placeholder="repo" value="" disabled />
            <button type="button" className={btnPrimary} disabled>Bind</button>
          </div>
        </>
      ) : (
        <>
      {error && <p role="alert" className="text-2xs text-[var(--danger)]">{error}</p>}
      {!status ? null : status.bound ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-ui-xs">
            Connected to <code>{status.owner}/{status.name}</code>
            {status.last_commit_sha ? ` · ${status.last_commit_sha.slice(0, 8)}` : ''}
          </p>
          <button
            type="button"
            className={btnGhost}
            disabled={busy || !checkpointId}
            onClick={async () => {
              if (!checkpointId) return
              setBusy(true)
              try {
                await pushGitCheckpoint(projectId, checkpointId)
                toast.push('success', 'Checkpoint pushed')
                await refresh()
              } catch (cause) {
                report(cause)
              } finally {
                setBusy(false)
              }
            }}
          >
            Push
          </button>
          <button
            type="button"
            className={btnGhost}
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await pullGitWebhook(projectId, {})
                toast.push('success', 'Checkpoint pulled')
                await refresh()
              } catch (cause) {
                report(cause)
              } finally {
                setBusy(false)
              }
            }}
          >
            Pull
          </button>
          <button
            type="button"
            className={btnGhost}
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await unbindGitRemote(projectId)
                toast.push('success', 'GitHub repository disconnected')
                await refresh()
              } catch (cause) {
                report(cause)
              } finally {
                setBusy(false)
              }
            }}
          >
            Disconnect
          </button>
        </div>
      ) : (
        <>
          <p className="text-3xs text-[var(--ink-muted)]">Connect a GitHub repository for this project.</p>
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
                  toast.push('success', 'Repository connected')
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
        </>
      )}
        </>
      )}
    </div>
  )
}

export function ProjectDomainsPanel({ projectId }: { projectId: string }) {
  const toast = useToast()
  const health = useBuildHealth()
  const [claims, setClaims] = useState<DomainClaim[]>([])
  const [hostname, setHostname] = useState('')
  const [busy, setBusy] = useState(false)
  const domainsLive = health.data?.domains_mode === 'live'

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
      {health.isFetched && !domainsLive ? (
        <p className="text-3xs text-[var(--ink-muted)]">Custom domains are not connected</p>
      ) : (
      <>
      <p className="text-3xs text-[var(--ink-muted)]">
        Connect a custom domain. Add the TXT record at your DNS host, then verify ownership.
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
                      await verifyProjectDomain(projectId, claim.hostname, false)
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
      </>
      )}
    </div>
  )
}
