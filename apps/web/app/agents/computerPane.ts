/** Right-hand Loop Bot column. Dragged width is remembered; the live size never exceeds 70% of the window. */
export const COMPUTER_PANE_KEY = 'loopBotComputerPaneWidth'
export const COMPUTER_PANE_MIN = 360
export const COMPUTER_PANE_DEFAULT = 400

export function computerPaneMax(windowWidth: number) {
  const width = Number.isFinite(windowWidth) ? windowWidth : 1280
  return Math.max(COMPUTER_PANE_MIN, Math.round(width * 0.7))
}

export function clampComputerPaneWidth(n: number, windowWidth: number) {
  const max = computerPaneMax(windowWidth)
  const value = Number.isFinite(n) ? Math.round(n) : COMPUTER_PANE_DEFAULT
  return Math.min(max, Math.max(COMPUTER_PANE_MIN, value))
}
