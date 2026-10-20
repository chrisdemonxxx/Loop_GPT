import { describe, expect, it } from 'vitest'
import { ComputerSession, COMPUTER_FALLBACK_SCREEN } from '../computerSession'
import { buildComputerSystemAddendum } from '../botRunner'

describe('computer resolution unification', () => {
  it('fallback screen matches E2B desktop default 1366×768', () => {
    expect(COMPUTER_FALLBACK_SCREEN).toEqual({ width: 1366, height: 768 })
  })

  it('parseScreenDimensions keeps a live 1366×768 probe', () => {
    expect(ComputerSession.parseScreenDimensions('  dimensions:    1366x768 pixels')).toEqual({
      width: 1366,
      height: 768,
    })
  })

  it('buildComputerSystemAddendum embeds live screen size (never 1024 when box is 1366)', () => {
    const text = buildComputerSystemAddendum({ width: 1366, height: 768 })
    expect(text).toContain('1366x768')
    expect(text).not.toContain('1024x768')
  })
})
