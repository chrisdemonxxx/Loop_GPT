import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import Composer from '../Composer'
import type { PendingAttachment } from '../../../chat/hooks'

const attach = (over: Partial<PendingAttachment>): PendingAttachment => ({
  id: 'a1', kind: 'image', name: 'pic.png', file: new File([], 'pic.png'), progress: 0, status: 'uploading', ...over,
})

const base = {
  input: '',
  attachments: [] as PendingAttachment[],
  onRemoveAttachment: () => {},
  onRetryAttachment: () => {},
  running: false,
  runMode: 'auto' as 'auto' | 'plan' | 'step' | 'accept',
  webSearch: 'auto' as 'auto' | 'on' | 'off',
  onToggleWebSearch: () => {},
  /** Contract §A (rank 7): the 6-value effort union. */
  thinking: 'auto' as 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'off',
  onToggleThinking: () => {},
  showSlash: false,
  showPlus: false,
  onInputChange: () => {},
  onSelectSlashCommand: () => {},
  onSend: () => {},
  onStop: () => {},
  onImagesSelected: () => {},
  onTogglePlus: () => {},
  onClosePlus: () => {},
  onRunModeChange: () => {},
  onOpenConnectors: () => {},
  onOpenSettingsTab: () => {},
  connections: undefined as Array<{ id: string; name: string; type: string }> | undefined,
  pinnedConnectionId: undefined as string | null | undefined,
  onTogglePinConnection: undefined as ((id: string) => void) | undefined,
  voiceMode: undefined as boolean | undefined,
  voiceModeSupported: undefined as boolean | undefined,
  voiceModeListening: undefined as boolean | undefined,
  onToggleVoiceMode: undefined as (() => void) | undefined,
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

  it('enables Send when an attachment is uploaded (even without text)', () => {
    renderComposer({ attachments: [attach({ status: 'done' })] })
    expect(screen.getByLabelText('Send message')).toBeEnabled()
  })

  it('renders one attachment entry point (the + menu trigger)', () => {
    renderComposer()
    expect(document.querySelectorAll('button[aria-label*="file"], button[title*="file"]').length).toBe(0)
  })

  it('shows a multi-image preview row with upload progress', () => {
    renderComposer({
      attachments: [
        attach({ id: 'a1', previewUrl: 'data:image/png;base64,AA==', progress: 40 }),
        attach({ id: 'a2', previewUrl: 'data:image/png;base64,BB==', progress: 90 }),
      ],
    })
    expect(screen.getByAltText('preview 1')).toBeInTheDocument()
    expect(screen.getByAltText('preview 2')).toBeInTheDocument()
    // Live progress bars ride the chips.
    expect(document.querySelectorAll('span[aria-hidden] span.block, span.h-1.rounded-full.bg-black\\/50').length).toBeGreaterThan(0)
  })

  it('shows a visible error with Retry on a failed image upload (was silent)', () => {
    const onRetryAttachment = vi.fn()
    renderComposer({ attachments: [attach({ status: 'error', error: 'Upload failed' })], onRetryAttachment })
    fireEvent.click(screen.getByRole('button', { name: /retry upload of pic\.png/i }))
    expect(onRetryAttachment).toHaveBeenCalledWith('a1')
  })

  it('dispatches drag-dropped files to the attach handler with the drop zone visible', () => {
    const onImagesSelected = vi.fn()
    const { container } = renderComposer({ onImagesSelected })
    const zone = container.firstChild as HTMLElement
    const file = new File(['x'], 'drop.png', { type: 'image/png' })
    fireEvent.dragEnter(zone, { dataTransfer: { types: ['Files'] } })
    expect(screen.getByText('Drop files to attach')).toBeInTheDocument()
    fireEvent.drop(zone, { dataTransfer: { files: [file] } })
    expect(onImagesSelected).toHaveBeenCalledWith([file])
    expect(screen.queryByText('Drop files to attach')).not.toBeInTheDocument()
  })

  it('attaches pasted clipboard images via onPaste', () => {
    const onImagesSelected = vi.fn()
    renderComposer({ input: 'x', onImagesSelected })
    const file = new File(['x'], 'pasted.png', { type: 'image/png' })
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [file] } })
    expect(onImagesSelected).toHaveBeenCalledWith([file])
  })

  it('Run settings (Option A): one chip opens one panel with all three axes', () => {
    renderComposer()
    const chip = screen.getByRole('button', { name: /run settings/i })
    expect(chip.textContent).toContain('Auto')
    fireEvent.click(chip)
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    const menu = screen.getByRole('menu', { name: 'Run settings' })
    // Autonomy: all four run modes
    for (const label of ['Plan', 'Ask first', 'Accept edits']) {
      expect(within(menu).getByText(label)).toBeInTheDocument()
    }
    // Web search: the 3-way segmented control
    expect(within(menu).getByRole('radiogroup', { name: 'Web search' })).toBeInTheDocument()
    // Reasoning: all six positions
    for (const label of ['Low', 'Medium', 'High', 'XHigh', 'Off']) {
      expect(within(menu).getByText(label)).toBeInTheDocument()
    }
  })

  it('Run settings: picking autonomy / web / reasoning dispatches each handler', () => {
    const onRunModeChange = vi.fn()
    const onToggleWebSearch = vi.fn()
    const onToggleThinking = vi.fn()
    renderComposer({ onRunModeChange, onToggleWebSearch, onToggleThinking })
    const chip = screen.getByRole('button', { name: /run settings/i })
    fireEvent.click(chip)
    const menu = screen.getByRole('menu', { name: 'Run settings' })
    fireEvent.click(within(menu).getByText('Ask first'))
    expect(onRunModeChange).toHaveBeenCalledWith('step')
    fireEvent.click(within(menu).getByRole('radio', { name: 'on' }))
    expect(onToggleWebSearch).toHaveBeenCalledWith('on')
    fireEvent.click(within(menu).getByText('XHigh'))
    expect(onToggleThinking).toHaveBeenCalledWith('xhigh')
  })

  it('Run settings: any non-default axis flips the chip to the accented Custom state', () => {
    renderComposer({ webSearch: 'on' })
    const chip = screen.getByRole('button', { name: /run settings \(customized\)/i })
    expect(chip.textContent).toContain('Custom')
    expect(chip.className).toContain('chip-on')
  })

  it('Run settings: all-default axes read Auto with no accent', () => {
    renderComposer({ runMode: 'auto', webSearch: 'auto', thinking: 'auto' })
    const chip = screen.getByRole('button', { name: /^run settings$/i })
    expect(chip.textContent).toContain('Auto')
    expect(chip.className).not.toContain('chip-on')
  })

  it('Run settings: click-away closes the popover', async () => {
    renderComposer()
    const chip = screen.getByRole('button', { name: /run settings/i })
    fireEvent.click(chip)
    expect(screen.getByRole('menu', { name: 'Run settings' })).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    // AnimatePresence removes the node after the 120ms exit transition.
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Run settings' })).toBeNull())
  })
})

describe('workspace-connection chips (§8-40)', () => {
  const connections = [
    { id: 'conn-a', name: 'Acme CRM', type: 'http' },
    { id: 'conn-b', name: 'Billing API', type: 'http' },
  ]

  it('renders the chips and toggles the pin', () => {
    const onTogglePinConnection = vi.fn()
    renderComposer({ connections, pinnedConnectionId: null, onTogglePinConnection })
    expect(screen.getByTestId('connector-chips')).toBeInTheDocument()
    // The chip's visible label is its accessible name; the title carries the hint.
    const chip = screen.getByRole('button', { name: /Acme CRM/ })
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    expect(chip.title).toContain('pin for the next run')
    fireEvent.click(chip)
    expect(onTogglePinConnection).toHaveBeenCalledWith('conn-a')
  })

  it('marks the pinned chip visually and lets clicking unpin', () => {
    const onTogglePinConnection = vi.fn()
    renderComposer({ connections, pinnedConnectionId: 'conn-a', onTogglePinConnection })
    const chip = screen.getByRole('button', { name: /Acme CRM/ })
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(chip.className).toContain('text-[#e79d7f]')
    expect(chip.title).toContain('pinned')
    fireEvent.click(chip)
    expect(onTogglePinConnection).toHaveBeenCalledWith('conn-a')
  })

  it('hides the chip row when there are no connections', () => {
    renderComposer()
    expect(screen.queryByTestId('connector-chips')).not.toBeInTheDocument()
  })
})

describe('hands-free voice mode toggle (§8-44)', () => {
  it('renders when supported and reflects the active state', () => {
    const onToggleVoiceMode = vi.fn()
    renderComposer({ voiceModeSupported: true, voiceMode: false, onToggleVoiceMode })
    const btn = screen.getByTestId('voice-mode-toggle')
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(btn)
    expect(onToggleVoiceMode).toHaveBeenCalled()
  })

  it('shows the listening state on the active toggle', () => {
    renderComposer({ voiceModeSupported: true, voiceMode: true, voiceModeListening: true, onToggleVoiceMode: () => {} })
    const btn = screen.getByTestId('voice-mode-toggle')
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(btn.title).toContain('listening')
  })

  it('is hidden on unsupported browsers (no Web Speech API)', () => {
    renderComposer({ voiceModeSupported: false, onToggleVoiceMode: () => {} })
    expect(screen.queryByTestId('voice-mode-toggle')).not.toBeInTheDocument()
  })
})
