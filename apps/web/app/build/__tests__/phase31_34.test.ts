import { describe, expect, it, vi } from 'vitest'
import { createLoopitClient } from '@loop/loopit-client'
import { buildFileTree, filterFiles, languageForPath } from '../fileTree'
import {
  normalizePreviewRoute,
  previewIframeKey,
  previewMaxWidth,
  previewRouteOptions,
  shouldClearInspectAfterEdit,
} from '../previewDevices'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Phase 3.1 file tree helpers', () => {
  it('builds a nested tree with dirs before files', () => {
    const tree = buildFileTree(['src/App.tsx', 'index.html', 'src/lib/util.ts'])
    expect(tree.map((n) => n.name)).toEqual(['src', 'index.html'])
    const src = tree.find((n) => n.name === 'src')!
    expect(src.kind).toBe('dir')
    expect(src.children?.map((c) => c.name)).toEqual(['lib', 'App.tsx'])
  })

  it('filters files by query', () => {
    expect(filterFiles(['App.js', 'styles.css', 'src/App.tsx'], 'app')).toEqual(['App.js', 'src/App.tsx'])
  })

  it('maps extensions to monaco languages', () => {
    expect(languageForPath('src/App.tsx')).toBe('typescript')
    expect(languageForPath('index.html')).toBe('html')
    expect(languageForPath('unknown')).toBe('plaintext')
  })
})

describe('Phase 3.3 / 3.4 preview helpers', () => {
  it('exposes tablet 768 and custom widths', () => {
    expect(previewMaxWidth('tablet', null)).toBe(768)
    expect(previewMaxWidth('mobile', null)).toBe(390)
    expect(previewMaxWidth('desktop', null)).toBeUndefined()
    expect(previewMaxWidth('custom', 900)).toBe(900)
    expect(previewMaxWidth('custom', 100)).toBe(320)
  })

  it('normalizes routes and builds route options', () => {
    expect(normalizePreviewRoute('/')).toBe('index.html')
    expect(normalizePreviewRoute('/about')).toBe('about')
    expect(previewRouteOptions(['index.html', 'about.html', 'App.js'])).toContain('about.html')
  })

  it('keeps HMR iframe key stable across epochs', () => {
    expect(previewIframeKey({ url: 'https://p/x', epoch: 1, hmr: true })).toBe('https://p/x')
    expect(previewIframeKey({ url: 'https://p/x', epoch: 2, hmr: true })).toBe('https://p/x')
    expect(previewIframeKey({ url: 'https://p/x', epoch: 2, hmr: false })).toBe('https://p/x#2')
  })

  it('keeps inspect selection after HMR visual edits', () => {
    expect(shouldClearInspectAfterEdit({ applied: true, hmr: true, keepSelection: true })).toBe(false)
    expect(shouldClearInspectAfterEdit({ applied: true, hmr: false, keepSelection: true })).toBe(true)
    expect(shouldClearInspectAfterEdit({ applied: false, hmr: true, keepSelection: true })).toBe(true)
  })
})

describe('Phase 3.1–3.3 client seams', () => {
  it('applyProjectPatch posts path + content', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/token')) {
        return json({ token: 'tok', expiresAt: new Date(Date.now() + 120_000).toISOString() })
      }
      expect(url).toContain('/projects/proj_1/apply-patch')
      expect(init?.method).toBe('POST')
      const body = JSON.parse(String(init?.body))
      expect(body.path).toBe('App.js')
      expect(body.content).toContain('Hello')
      return json({
        ok: true,
        path: 'App.js',
        file_changes: [{ path: 'App.js', op: 'modify', diff: '+x', additions: 1, deletions: 0 }],
        checkpoint: { checkpoint_id: 'cp_1', verified: false, label: 'user edit' },
      })
    })
    const client = createLoopitClient({ fetchImpl })
    const result = await client.applyProjectPatch('proj_1', { path: 'App.js', content: 'Hello\n' })
    expect(result.ok).toBe(true)
    expect(result.checkpoint?.checkpoint_id).toBe('cp_1')
  })

  it('getPreviewMeta and getPtyInfo hit engine paths', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/token')) {
        return json({ token: 'tok', expiresAt: new Date(Date.now() + 120_000).toISOString() })
      }
      if (url.includes('/preview-meta')) {
        return json({ project_id: 'proj_1', path: 'index.html', title: 'Demo', description: 'Hi' })
      }
      if (url.endsWith('/pty')) {
        return json({
          project_id: 'proj_1',
          available: false,
          mode: 'offline',
          ws_path: '/api/projects/proj_1/pty/ws',
          detail: 'offline',
        })
      }
      return json({})
    })
    const client = createLoopitClient({ fetchImpl })
    const meta = await client.getPreviewMeta('proj_1')
    expect(meta.title).toBe('Demo')
    const pty = await client.getPtyInfo('proj_1')
    expect(pty.available).toBe(false)
    expect(pty.mode).toBe('offline')
  })
})
