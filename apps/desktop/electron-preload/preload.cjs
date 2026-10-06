'use strict'

/**
 * Preload (sand's preload.cjs role): the ONLY bridge between the sandboxed
 * renderer and the shell. Kept intentionally tiny — the web app runs
 * unmodified; this exposes desktop capabilities only, never Node.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('loopDesktop', {
  /** Desktop capability flags (renderer feature-detects, no Node access). */
  isDesktop: true,
  platform: process.platform,
  /** Shell version (matches package.json; injected by the build). */
  version: process.env.LOOP_DESKTOP_VERSION || '0.1.0',
  /** Window control (future: custom titlebar). */
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  /**
   * OAuth popup bridge: runs the provider sign-in flow on the real site
   * origin in a popup window and resolves when the session lands in the
   * main window ({ok}), the popup was closed ({cancelled}), or {error}.
   */
  startOAuth: (path) => ipcRenderer.invoke('oauth:start', path),
})