import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
  thinking: 'auto' as 'auto' | 'on' | 'off',
  onToggleThinking: () => {},
  showSlash: false,
  showPlus: false,
  showModeMenu: false,
  onInputChange: () => {},
  onSelectSlashCommand: () => {},
  onSend: () => {},
  onStop: () => {},
  onImagesSelected: () => {},
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

  it('renders the web-search and thinking toggles cycling Auto → On → Off', () => {
    const onToggleWebSearch = vi.fn()
    const onToggleThinking = vi.fn()
    const { rerender } = renderComposer({ onToggleWebSearch, onToggleThinking })
    const web = screen.getByRole('button', { name: /web search: auto/i })
    const brain = screen.getByRole('button', { name: /extended thinking: auto/i })
    expect(web).toBeInTheDocument()
    expect(brain).toBeInTheDocument()
    // Cycle from auto lands on on; from on lands on off.
    fireEvent.click(web)
    expect(onToggleWebSearch).toHaveBeenCalledWith('on')
    renderComposer({ webSearch: 'on', onToggleWebSearch, onToggleThinking })
    fireEvent.click(screen.getByRole('button', { name: /web search: on/i }))
    expect(onToggleWebSearch).toHaveBeenCalledWith('off')
    renderComposer({ webSearch: 'off', onToggleWebSearch, onToggleThinking })
    fireEvent.click(screen.getByRole('button', { name: /web search: off/i }))
    expect(onToggleWebSearch).toHaveBeenCalledWith('auto')
    fireEvent.click(brain)
    expect(onToggleThinking).toHaveBeenCalledWith('on')
  })

  it('marks explicit toggle states visually (on = terracotta, off = struck)', () => {
    renderComposer({ webSearch: 'on', thinking: 'off' })
    const web = screen.getByRole('button', { name: /web search: on/i })
    const brain = screen.getByRole('button', { name: /extended thinking: off/i })
    expect(web.className).toContain('text-[#e79d7f]')
    expect(web.getAttribute('aria-pressed')).toBe('true')
    expect(brain.getAttribute('aria-pressed')).toBe('true')
    expect(brain.className).toContain('line-through')
  })
})
