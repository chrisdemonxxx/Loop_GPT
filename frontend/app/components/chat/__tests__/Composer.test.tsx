import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import Composer from '../Composer'

const base = {
  input: '',
  imagePreviews: [] as string[],
  running: false,
  runMode: 'auto' as 'auto' | 'plan' | 'step' | 'accept',
  showSlash: false,
  showPlus: false,
  showModeMenu: false,
  onInputChange: () => {},
  onSelectSlashCommand: () => {},
  onSend: () => {},
  onStop: () => {},
  onImagesSelected: () => {},
  onRemoveImage: () => {},
  onTogglePlus: () => {},
  onClosePlus: () => {},
  onToggleModeMenu: () => {},
  onCloseModeMenu: () => {},
  onRunModeChange: () => {},
  onOpenConnectors: () => {},
  onOpenSettingsTab: () => {},
  toolSelectionCount: null as number | null,
}

// The i18n provider is required by the composer.
import { I18nProvider } from '../../../lib/i18n'

function renderComposer(overrides: Partial<typeof base> = {}) {
  return render(<I18nProvider><Composer {...base} {...overrides} /></I18nProvider>)
}

describe('Composer', () => {
  it('disables Send with no input and enables it with text', () => {
    renderComposer({ input: 'hello' })
    expect(screen.getByLabelText('Send message')).toBeEnabled()
  })

  it('disables Send when empty', () => {
    renderComposer()
    expect(screen.getByLabelText('Send message')).toBeDisabled()
  })

  it('renders one attachment entry point (the + menu trigger)', () => {
    renderComposer()
    expect(document.querySelectorAll('button[aria-label*="file"], button[title*="file"]').length).toBe(0)
  })

  it('shows a multi-image preview row when previews are present', () => {
    renderComposer({ imagePreviews: ['data:image/png;base64,AA==', 'data:image/png;base64,BB=='] })
    expect(screen.getByAltText('preview 1')).toBeInTheDocument()
    expect(screen.getByAltText('preview 2')).toBeInTheDocument()
  })

  it('shows all four run modes in the mode menu', () => {
    renderComposer({ showModeMenu: true })
    for (const label of ['Auto', 'Plan', 'Ask first', 'Accept edits']) {
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(1)
    }
  })

  it('marks the non-default active mode on the collapsed button', () => {
    renderComposer({ runMode: 'step' })
    expect(screen.getByTitle('Confirm before every action').textContent).toContain('Ask first')
  })
})
