/**
 * The @novnc/novnc package ships no type declarations and its exports field
 * only exposes the root specifier, so the module declaration targets the
 * bare import — deep subpaths like core/rfb are not resolvable.
 */
declare module '@novnc/novnc' {
  export interface RFBOptions {
    shared?: boolean
    viewOnly?: boolean
    resizeSession?: boolean
    scaleViewport?: boolean
    /** Plan name. noVNC 1.7 applies the same flag as `clipViewport`. */
    clampViewport?: boolean
    clipViewport?: boolean
    credentials?: { password?: string; username?: string; target?: string }
    wsProtocols?: string | string[]
    repeaterID?: string
  }

  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: RFBOptions)
    sendCredentials(credentials: { password?: string; username?: string; target?: string }): void
    disconnect(): void
    addEventListener(event: string, handler: (ev?: any) => void): void
    removeEventListener(event: string, handler: (ev?: any) => void): void
    readonly _rfbConnectionState: string
    /** Fit the remote framebuffer into the container. Setter re-runs scale. */
    scaleViewport: boolean
    /** Must stay false — the remote desktop stays 1366×768. */
    resizeSession: boolean
    clampViewport: boolean
    /** noVNC 1.7 name for clampViewport. */
    clipViewport: boolean
    viewOnly: boolean
  }
}
