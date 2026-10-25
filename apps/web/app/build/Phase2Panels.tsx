'use client'

/**
 * Phase 2.1 / 2.2 / 2.8 panels used by RunView (visual edit chip helpers,
 * browser test replay card, security findings). Kept separate so parallel
 * agents can touch Console/Database/Secrets without merge conflicts here.
 */

import { useEffect, useState } from 'react'
import { Shield, X } from 'lucide-react'
import { Badge, btnGhost, btnOutline, btnPrimary } from '@loop/ui'
import {
  listBrowserTests,
  getSecurityScan,
  type BrowserTestRun,
  type SecurityScanResult,
} from '@loop/loopit-client'

export type InspectTarget = {
  selector: string
  snippet: string
  loc: string | null
  tag: string | null
  text: string
}

export function EditingElementChip({
  target,
  onClear,
}: {
  target: InspectTarget
  onClear: () => void
}) {
  const label = target.tag ? `<${target.tag}>` : 'element'
  const loc = target.loc ? target.loc.split('/').pop() : null
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--accent-soft-border)] bg-[var(--accent-soft)] px-2 py-1 text-2xs text-[var(--accent-text)]">
        editing {label}
        {loc && <span className="font-mono opacity-70">{loc}</span>}
        <button type="button" onClick={onClear} className="ml-0.5 opacity-70 hover:opacity-100" aria-label="Clear selection">
          <X size={10} />
        </button>
      </span>
      {target.text && (
        <span className="truncate max-w-[12rem] text-3xs text-[var(--ink-muted)]">&ldquo;{target.text}&rdquo;</span>
      )}
    </div>
  )
}

export function SecurityPanel({ projectId }: { projectId: string | null }) {
  const [scan, setScan] = useState<SecurityScanResult | null>(null)

  useEffect(() => {
    if (!projectId) return
    void getSecurityScan(projectId)
      .then(setScan)
      .catch(() => setScan(null))
  }, [projectId])

  if (!projectId) {
    return <p className="p-3 text-2xs text-[var(--ink-muted)]">Open a project to run a security scan.</p>
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col p-3 gap-3 overflow-auto">
      <div className="flex items-center gap-2">
        <Shield size={14} className="text-[var(--ink-secondary)]" />
        <p className="text-ui-xs font-medium text-[var(--ink-primary)]">Security scan</p>
        <button
          type="button"
          className={btnOutline}
          disabled
          title="Security scanning is not available until a live scanner is connected."
        >
          Scan now
        </button>
        {scan?.passed === true && <Badge tone="green">Passed</Badge>}
        {scan?.passed === false && <Badge tone="rose">Blocking</Badge>}
      </div>
      <p className="text-3xs text-[var(--ink-muted)]">Security scanning is not available until a live scanner is connected.</p>
      {scan?.summary && <p className="text-2xs text-[var(--ink-secondary)]">{scan.summary}</p>}
      <ul className="space-y-2">
        {(scan?.findings ?? []).map((finding, index) => (
          <li
            key={`${finding.rule_id}-${index}`}
            className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2.5"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={finding.blocks_publish ? 'rose' : 'neutral'}>{finding.severity}</Badge>
              <span className="font-mono text-3xs text-[var(--ink-muted)]">{finding.rule_id}</span>
            </div>
            <p className="mt-1 text-2xs text-[var(--ink-primary)]">{finding.plain || finding.message}</p>
            {finding.path && (
              <p className="mt-0.5 font-mono text-3xs text-[var(--ink-muted)]">
                {finding.path}{finding.line != null ? `:${finding.line}` : ''}
              </p>
            )}
          </li>
        ))}
      </ul>
      {!scan?.findings?.length && (
        <p className="text-2xs text-[var(--ink-muted)]">No findings yet.</p>
      )}
    </div>
  )
}

export function BrowserTestsPanel({
  projectId,
}: {
  projectId: string | null
  previewUrl: string | null
}) {
  const [runs, setRuns] = useState<BrowserTestRun[]>([])
  const [selected, setSelected] = useState<BrowserTestRun | null>(null)

  const refresh = () => {
    if (!projectId) return
    void listBrowserTests(projectId).then(setRuns).catch(() => setRuns([]))
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh on project change only
  }, [projectId])

  if (!projectId) {
    return <p className="p-3 text-2xs text-[var(--ink-muted)]">Open a project to run browser tests.</p>
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col p-3 gap-3 overflow-auto">
      <div className="flex items-center gap-2">
        <p className="text-ui-xs font-medium text-[var(--ink-primary)]">Test runs</p>
        <button
          type="button"
          className={btnPrimary}
          disabled
          title="Browser tests are not available until a live runner is connected."
        >
          Run test
        </button>
      </div>
      <p className="text-3xs text-[var(--ink-muted)]">Browser tests are not available until a live runner is connected.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <ul className="space-y-1.5">
          {runs.map((run) => (
            <li key={run.test_id}>
              <button
                type="button"
                onClick={() => setSelected(run)}
                className={`w-full rounded-lg border px-2.5 py-2 text-left text-2xs transition ${
                  selected?.test_id === run.test_id
                    ? 'border-[var(--accent-soft-border)] bg-[var(--accent-soft)]'
                    : 'border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                <span className="font-medium">{run.status}</span>
                <span className="ml-2 text-[var(--ink-muted)]">{run.mode}</span>
                <p className="mt-0.5 truncate text-[var(--ink-secondary)]">{run.summary}</p>
              </button>
            </li>
          ))}
          {!runs.length && <p className="text-2xs text-[var(--ink-muted)]">No test runs yet.</p>}
        </ul>
        {selected && <TestRunReplayCard run={selected} onClose={() => setSelected(null)} />}
      </div>
    </div>
  )
}

function TestRunReplayCard({ run, onClose }: { run: BrowserTestRun; onClose: () => void }) {
  return (
    <article className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-ui-xs font-medium text-[var(--ink-primary)]">Test run</h3>
          <p className="mt-0.5 text-3xs text-[var(--ink-muted)] font-mono">{run.test_id}</p>
        </div>
        <button type="button" className={btnGhost} onClick={onClose} aria-label="Close">
          <X size={12} />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Badge tone={run.status === 'passed' ? 'green' : 'rose'}>{run.status}</Badge>
        <Badge tone="neutral">{run.mode}</Badge>
        {run.test_user?.email && <Badge tone="neutral">signed in as {run.test_user.email}</Badge>}
      </div>
      {run.summary && <p className="mt-2 text-2xs text-[var(--ink-secondary)]">{run.summary}</p>}
      {run.video_path && (
        <p className="mt-1 text-3xs text-[var(--ink-muted)]">Video artifact: {run.video_path}</p>
      )}
      {run.trace_path && (
        <p className="mt-0.5 text-3xs text-[var(--ink-muted)]">Trace: {run.trace_path}</p>
      )}
      <ol className="mt-3 max-h-40 space-y-1 overflow-auto font-mono text-3xs text-[var(--ink-secondary)]">
        {(run.steps ?? []).map((step) => (
          <li key={step.n}>
            {step.n}. [{step.kind}] {JSON.stringify({ ...step, n: undefined, t: undefined, kind: undefined })}
          </li>
        ))}
      </ol>
    </article>
  )
}
