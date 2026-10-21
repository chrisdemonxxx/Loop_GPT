/** Preview device presets and route helpers (Phase 3.3 / 3.4). */

export type PreviewDevice = 'desktop' | 'tablet' | 'mobile' | 'custom'

export const PREVIEW_DEVICE_WIDTHS: Record<Exclude<PreviewDevice, 'custom'>, number | undefined> = {
  desktop: undefined,
  tablet: 768,
  mobile: 390,
}

export function previewMaxWidth(device: PreviewDevice, customWidth: number | null): number | undefined {
  if (device === 'custom') {
    const w = customWidth && customWidth > 0 ? customWidth : 1024
    return Math.min(Math.max(w, 320), 2400)
  }
  return PREVIEW_DEVICE_WIDTHS[device]
}

/** HTML-ish entry routes plus common SPA paths for the route picker. */
export function previewRouteOptions(files: string[]): string[] {
  const html = files.filter((f) => /\.html?$/i.test(f)).sort()
  const extras = ['index.html', '/']
  const seen = new Set<string>()
  const out: string[] = []
  for (const route of [...html, ...extras]) {
    const key = route === '/' ? 'index.html' : route.replace(/^\//, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(route === '/' ? '/' : key)
  }
  return out
}

export function normalizePreviewRoute(route: string): string {
  const trimmed = route.trim()
  if (!trimmed || trimmed === '/') return 'index.html'
  return trimmed.replace(/^\//, '')
}

/** Keep visual-edit selection across HMR-friendly edits (Phase 3.4). */
export function shouldClearInspectAfterEdit(opts: {
  applied: boolean
  hmr: boolean
  keepSelection: boolean
}): boolean {
  if (!opts.applied) return true
  if (opts.hmr && opts.keepSelection) return false
  return true
}

/** Static previews remount on epoch; HMR must not (Phase 3.4 / 1.4). */
export function previewIframeKey(opts: { url: string; epoch: number; hmr: boolean }): string {
  return opts.hmr ? opts.url : `${opts.url}#${opts.epoch}`
}
