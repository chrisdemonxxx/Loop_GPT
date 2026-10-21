'use client'

/**
 * Phase 3.1 — editable Monaco drawer with file tree + search.
 * Saves via apply_patch (server generates the unified diff) + checkpoint.
 */

import { useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { ChevronDown, ChevronRight, FileCode2, Folder, Loader2, Save, Search, X } from 'lucide-react'
import { LoadingState, btnGhost, btnPrimary } from '@loop/ui'
import {
  applyProjectPatch,
  toUserFacingError,
  type FileChange,
} from '@loop/loopit-client'
import { DiffView } from './DiffView'
import { buildFileTree, filterFiles, languageForPath, type FileTreeNode } from './fileTree'
import { useCheckpointFile, useFileContent } from './hooks'

const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((m) => m.default), {
  ssr: false,
  loading: () => <LoadingState label="Loading editor…" />,
})

export function CodeEditorDrawer({
  runId,
  projectId,
  files,
  path,
  diffChange,
  compareCheckpointId,
  onClose,
  onSelectPath,
  onSaved,
  live = false,
}: {
  runId: string
  projectId: string | null
  files: string[]
  path: string
  diffChange: FileChange | null
  compareCheckpointId: string | null
  onClose: () => void
  onSelectPath: (path: string) => void
  onSaved?: () => void
  live?: boolean
}) {
  const fileQuery = useFileContent(runId, path)
  const checkpointQuery = useCheckpointFile(projectId, compareCheckpointId, path)
  const showDiff = !!diffChange?.diff
  const showCompare = !!compareCheckpointId && !showDiff

  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [treeOpen, setTreeOpen] = useState(true)

  const filtered = useMemo(() => filterFiles(files, search), [files, search])
  const tree = useMemo(() => buildFileTree(filtered), [filtered])

  useEffect(() => {
    if (fileQuery.data != null) {
      setDraft(fileQuery.data)
      setDirty(false)
      setSaveError(null)
    }
  }, [fileQuery.data, path])

  const save = async () => {
    if (!projectId || draft == null || !dirty || live) return
    setSaving(true)
    setSaveError(null)
    try {
      await applyProjectPatch(projectId, { path, content: draft, label: 'user edit', checkpoint: true })
      setDirty(false)
      onSaved?.()
    } catch (cause) {
      setSaveError(toUserFacingError(cause).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="absolute inset-y-0 right-0 w-full sm:w-[560px] max-w-full flex border-l border-[var(--border-subtle)] bg-[var(--bg-base)] shadow-panel z-10">
      {treeOpen && (
        <aside className="w-44 shrink-0 border-r border-[var(--border-subtle)] flex flex-col min-h-0">
          <div className="p-2 border-b border-[var(--border-subtle)]">
            <label className="flex items-center gap-1.5 rounded-lg bg-[var(--bg-sunken)] px-2 py-1.5">
              <Search size={11} className="text-[var(--ink-muted)] shrink-0" aria-hidden />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search files"
                className="w-full bg-transparent text-3xs text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)] focus:outline-none"
              />
            </label>
          </div>
          <div className="flex-1 min-h-0 overflow-auto p-1.5">
            <FileTreeView nodes={tree} selected={path} onSelect={onSelectPath} />
            {!tree.length && <p className="px-2 py-1 text-3xs text-[var(--ink-muted)]">No matches</p>}
          </div>
        </aside>
      )}

      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-subtle)] shrink-0">
          <button type="button" className={btnGhost} onClick={() => setTreeOpen((v) => !v)} title="Toggle file tree">
            <Folder size={12} />
          </button>
          <FileCode2 size={13} className="text-[var(--accent-text)] shrink-0" aria-hidden />
          <span className="flex-1 min-w-0 truncate font-mono text-ui-xs text-[var(--ink-primary)]">
            {path}
            {showDiff && <span className="ml-2 text-[var(--ink-muted)]">diff</span>}
            {showCompare && <span className="ml-2 text-[var(--ink-muted)]">vs checkpoint</span>}
            {dirty && !showDiff && !showCompare && <span className="ml-2 text-[var(--warning)]">edited</span>}
          </span>
          {!showDiff && !showCompare && (
            <button
              type="button"
              className={btnPrimary}
              disabled={!dirty || saving || live || !projectId}
              onClick={() => { void save() }}
              title={live ? 'Stop the build before saving edits' : 'Save via apply_patch + checkpoint'}
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              <span className="ml-1">Save</span>
            </button>
          )}
          <button type="button" onClick={onClose} aria-label="Close file" className="p-1 rounded-lg text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] transition">
            <X size={14} aria-hidden />
          </button>
        </div>

        {saveError && <p className="m-2 text-ui-xs text-[var(--danger)]" role="alert">{saveError}</p>}

        <div className="flex-1 min-h-0 overflow-hidden">
          {showDiff && <div className="h-full overflow-auto"><DiffView diff={diffChange!.diff} /></div>}
          {showCompare && (
            <div className="h-full overflow-auto">
              {checkpointQuery.isPending && <LoadingState label="Loading checkpoint…" />}
              {checkpointQuery.isError && <p className="m-3 text-ui-xs text-[var(--danger)]">{toUserFacingError(checkpointQuery.error).message}</p>}
              {checkpointQuery.data != null && fileQuery.data != null && (
                <DiffView
                  diff={[
                    `--- a/${path} (checkpoint)`,
                    `+++ b/${path} (live)`,
                    ...checkpointQuery.data.split('\n').map((line) => `- ${line}`),
                    ...fileQuery.data.split('\n').map((line) => `+ ${line}`),
                  ].join('\n')}
                />
              )}
            </div>
          )}
          {!showDiff && !showCompare && (
            <>
              {fileQuery.isPending && <LoadingState label="Reading file…" />}
              {fileQuery.isError && <p className="m-3 text-ui-xs text-[var(--danger)]">{toUserFacingError(fileQuery.error).message}</p>}
              {draft != null && (
                <div className="h-full" data-testid="monaco-editor-host">
                  <MonacoEditor
                    height="100%"
                    language={languageForPath(path)}
                    theme="vs-dark"
                    value={draft}
                    onChange={(value) => {
                      setDraft(value ?? '')
                      setDirty(true)
                    }}
                    options={{
                      minimap: { enabled: false },
                      fontSize: 12,
                      wordWrap: 'on',
                      automaticLayout: true,
                      readOnly: live,
                      scrollBeyondLastLine: false,
                    }}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function FileTreeView({
  nodes,
  selected,
  onSelect,
  depth = 0,
}: {
  nodes: FileTreeNode[]
  selected: string
  onSelect: (path: string) => void
  depth?: number
}) {
  return (
    <ul className="m-0 list-none p-0">
      {nodes.map((node) => (
        <FileTreeItem key={node.path} node={node} selected={selected} onSelect={onSelect} depth={depth} />
      ))}
    </ul>
  )
}

function FileTreeItem({
  node,
  selected,
  onSelect,
  depth,
}: {
  node: FileTreeNode
  selected: string
  onSelect: (path: string) => void
  depth: number
}) {
  const [open, setOpen] = useState(depth < 2)
  if (node.kind === 'dir') {
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-3xs text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
          style={{ paddingLeft: 6 + depth * 10 }}
        >
          {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          <Folder size={10} />
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children && (
          <FileTreeView nodes={node.children} selected={selected} onSelect={onSelect} depth={depth + 1} />
        )}
      </li>
    )
  }
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        className={`flex w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left font-mono text-3xs transition ${
          selected === node.path
            ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]'
            : 'text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]'
        }`}
        style={{ paddingLeft: 6 + depth * 10 }}
      >
        <FileCode2 size={10} className="shrink-0 opacity-70" />
        <span className="truncate">{node.name}</span>
      </button>
    </li>
  )
}
