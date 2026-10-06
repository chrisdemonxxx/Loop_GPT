/** Desktop shell bridge (apps/desktop/electron-preload/preload.cjs). Present
 *  only inside the Electron shell; the web build never sees it. */
interface LoopDesktop {
  isDesktop: true
  platform: NodeJS.Platform
  version: string
  minimize: () => void
  maximize: () => void
  close: () => void
  startOAuth: (path: string) => Promise<{ ok?: boolean; cancelled?: boolean; error?: string }>
}

interface Window {
  loopDesktop?: LoopDesktop
}