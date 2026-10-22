import { describe, expect, it } from 'vitest'
import { COMPUTER_PANE_MIN, clampComputerPaneWidth } from '../computerPane'

describe('clampComputerPaneWidth', () => {
  it('keeps the pane between 360px and 70% of the window', () => {
    expect(clampComputerPaneWidth(200, 1200)).toBe(COMPUTER_PANE_MIN)
    expect(clampComputerPaneWidth(500, 1200)).toBe(500)
    expect(clampComputerPaneWidth(2000, 1000)).toBe(700)
  })

  it('does not shrink below the minimum when the window is narrow', () => {
    expect(clampComputerPaneWidth(100, 400)).toBe(COMPUTER_PANE_MIN)
  })
})
