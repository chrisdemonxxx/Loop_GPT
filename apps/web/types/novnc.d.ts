declare module '@novnc/novnc/core/rfb' {
  export interface RFBOptions {
    shared?: boolean
    viewOnly?: boolean
    resizeSession?: boolean
    scaleViewport?: boolean
    clampViewport?: boolean
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
  }
}
