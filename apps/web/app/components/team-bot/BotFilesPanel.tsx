'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  ChevronRight, FileCode2, Folder, FolderOpen, Loader2, RefreshCw, Save, Trash2, Upload, X,
} from 'lucide-react'
import { deleteBoxFile, listBoxFiles, readBoxFile, writeBoxFile, type BoxFileEntry } from '@loop/api-client'
import { useToast } from '../../lib/toast'

/**
 * The box's own filesystem, from the operator's side.
 *
 * The bot writes here with computer tools; the operator reads, edits, uploads
 * and deletes through this panel — one filesystem, two writers, no sync
 * protocol that could drift. Changes land immediately for the bot's next run.
 */
export function BotFilesPanel() {
  const toast = useToast()
  const [path, setPath] = useState<string[]>([])
  const [entries, setEntries] = useState<BoxFileEntry[] | null>(null)
  const [openFile, setOpenFile] = useState<{ path: string; content: string; dirty: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const currentDir = `/workspace${path.length ? `/${path.join('/')}` : ''}`

  const refresh = useCallback(async (dir: string) => {
    setError('')
    try {
      const body = await listBoxFiles(dir)
      setEntries(body.entries)
    } catch (err: any) {
      setEntries(null)
      setError(err?.message || 'Could not read the workspace.')
    }
  }, [])

  useEffect(() => { void refresh(currentDir) }, [currentDir, refresh])

  const openDir = (entry: BoxFileEntry) => {
    if (entry.type === 'dir') { setPath((prev) => [...prev, entry.name]); setOpenFile(null); return }
    void (async () => {
      setBusy(true)
      try {
        const body = await readBoxFile(entry.path)
        setOpenFile({ path: entry.path, content: body.content, dirty: false })
      } catch (err: any) {
        toast.push('error', err?.message || 'Could not read the file.')
      } finally {
        setBusy(false)
      }
    })()
  }

  const saveFile = async () => {
    if (!openFile) return
    setBusy(true)
    try {
      await writeBoxFile(openFile.path, openFile.content)
      setOpenFile({ ...openFile, dirty: false })
      toast.push('success', 'Saved to the computer')
    } catch (err: any) {
      toast.push('error', err?.message || 'Save failed.')
    } finally {
      setBusy(false)
    }
  }

  const upload = async (file: File) => {
    // Only text files — a binary blob converted with file.text() silently
    // mangles every non-UTF8 byte on the bot's computer, which is worse than
    // rejecting the upload with a clear error.
    const safe = /\.(txt|md|js|ts|jsx|tsx|html|css|json|xml|yaml|yml|py|sh|rb|go|rs|java|c|cpp|h|svg|env|cfg|ini|toml)$/i
    if (!safe.test(file.name)) {
      toast.push('error', `“${file.name}” looks like a binary or unsupported file — only text files can be edited inline.`)
      return
    }
    setBusy(true)
    try {
      const text = await file.text()
      await writeBoxFile(`${currentDir}/${file.name}`, text)
      await refresh(currentDir)
      toast.push('success', `Uploaded ${file.name}`)
    } catch (err: any) {
      toast.push('error', err?.message || 'Upload failed.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (entry: BoxFileEntry) => {
    setBusy(true)
    try {
      await deleteBoxFile(entry.path)
      if (openFile?.path === entry.path) setOpenFile(null)
      await refresh(currentDir)
    } catch (err: any) {
      toast.push('error', err?.message || 'Delete failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Path bar */}
      <div className="flex items-center gap-1 px-1 pb-2 text-ui-xs text-[var(--ink-muted)] shrink-0 flex-wrap">
        <button type="button" onClick={() => setPath([])} className="text-[var(--accent-text)] hover:underline font-mono">workspace</button>
        {path.map((piece, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight size={10} aria-hidden />
            <button type="button" onClick={() => setPath(path.slice(0, i + 1))} className="text-[var(--accent-text)] hover:underline font-mono">{piece}</button>
          </span>
        ))}
        <span className="flex-1" />
        <label className="flex items-center gap-1 rounded-lg px-2 py-1 text-2xs text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] cursor-pointer transition">
          <Upload size={11} aria-hidden /> Upload
          <input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = '' }} />
        </label>
        <button type="button" onClick={() => void refresh(currentDir)} className="p-1 rounded-lg hover:bg-[var(--bg-hover)] transition" aria-label="Refresh">
          <RefreshCw size={11} aria-hidden />
        </button>
      </div>

      <div className="flex-1 min-h-0 flex gap-2">
        {/* Tree */}
        <div className="w-1/2 min-w-0 overflow-y-auto rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] p-1.5">
          {busy && !entries && <div className="flex items-center gap-2 p-3 text-ui-xs text-[var(--ink-muted)]"><Loader2 size={12} className="animate-spin" /> Reading…</div>}
          {error && <p className="p-3 text-ui-xs text-[var(--danger)]">{error}</p>}
          {entries?.length === 0 && <p className="p-3 text-ui-xs text-[var(--ink-muted)]">Empty directory.</p>}
          {entries?.map((entry) => (
            <div key={entry.path} className="group flex items-center gap-1.5 rounded-lg px-2 py-1 hover:bg-[var(--bg-hover)] transition">
              <button type="button" onClick={() => openDir(entry)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                {entry.type === 'dir'
                  ? <Folder size={12} className="shrink-0 text-[var(--accent-text)]" aria-hidden />
                  : <FileCode2 size={12} className="shrink-0 text-[var(--ink-muted)]" aria-hidden />}
                <span className="truncate font-mono text-2xs text-[var(--ink-primary)]">{entry.name}</span>
                {entry.type === 'file' && <span className="ml-auto shrink-0 text-3xs text-[var(--ink-muted)]">{entry.size > 1024 ? `${(entry.size / 1024).toFixed(1)}k` : `${entry.size}b`}</span>}
              </button>
              <button type="button" onClick={() => void remove(entry)} className="hidden shrink-0 text-[var(--ink-muted)] hover:text-[var(--danger)] group-hover:block" aria-label={`Delete ${entry.name}`}>
                <Trash2 size={11} aria-hidden />
              </button>
            </div>
          ))}
        </div>

        {/* Viewer / editor */}
        <div className="w-1/2 min-w-0 flex flex-col rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] overflow-hidden">
          {openFile ? (
            <>
              <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-[var(--border-subtle)] shrink-0">
                <span className="flex-1 min-w-0 truncate font-mono text-2xs text-[var(--ink-primary)]">{openFile.path.split('/').pop()}</span>
                {openFile.dirty && <span className="text-3xs text-[var(--warning)]">unsaved</span>}
                <button type="button" onClick={() => void saveFile()} disabled={!openFile.dirty || busy} className="flex items-center gap-1 rounded-lg px-2 py-1 text-2xs text-white bg-[var(--accent-fill)] hover:bg-[var(--accent-fill-hover)] disabled:opacity-40 transition">
                  <Save size={10} aria-hidden /> Save
                </button>
                <button type="button" onClick={() => setOpenFile(null)} className="p-1 rounded-lg text-[var(--ink-muted)] hover:bg-[var(--bg-hover)]" aria-label="Close file">
                  <X size={11} aria-hidden />
                </button>
              </div>
              <textarea
                value={openFile.content}
                onChange={(e) => setOpenFile({ ...openFile, content: e.target.value, dirty: true })}
                spellCheck={false}
                className="flex-1 min-h-0 resize-none bg-transparent p-2.5 font-mono text-2xs leading-relaxed text-[var(--ink-secondary)] focus:outline-none"
              />
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <FolderOpen size={18} className="text-[var(--ink-muted)]" aria-hidden />
              <p className="text-2xs text-[var(--ink-muted)] leading-relaxed">
                Pick a file to view or edit it.<br />Changes land on the bot&apos;s computer immediately.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
