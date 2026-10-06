/** Ctrl on Windows/Linux, ⌘ on macOS. Advertised shortcuts follow the machine. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/i.test(navigator.platform || '') || /Mac/i.test(navigator.userAgent || '')
}

export function modLabel(): string {
  return isApplePlatform() ? '⌘' : 'Ctrl'
}

export function modKey(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.metaKey || e.ctrlKey
}
