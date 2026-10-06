import React from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import Composer from './Composer'
import type { PendingAttachment } from '../../chat/hooks'

const noop = () => {}

/** A 1x1 PNG so attachment chips render a real thumbnail, not a broken img. */
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const mkFile = (name: string, type = 'image/png') => new File(['x'], name, { type })

const attachments: PendingAttachment[] = [
  {
    id: 'att-1',
    kind: 'doc',
    name: 'ledger-schema.sql',
    file: mkFile('ledger-schema.sql', 'text/plain'),
    progress: 46,
    status: 'uploading',
  },
  {
    id: 'att-2',
    kind: 'image',
    name: 'composer-390.png',
    file: mkFile('composer-390.png'),
    previewUrl: PIXEL,
    progress: 100,
    status: 'done',
    attachmentId: 'file_2',
  },
  {
    id: 'att-3',
    kind: 'doc',
    name: 'runbook.pdf',
    file: mkFile('runbook.pdf', 'application/pdf'),
    progress: 100,
    status: 'error',
    error: 'Upload failed — connection reset',
  },
]

const baseArgs = {
  input: '',
  attachments: [] as PendingAttachment[],
  onRemoveAttachment: noop,
  onRetryAttachment: noop,
  running: false,
  runMode: 'auto' as const,
  webSearch: 'auto' as const,
  onToggleWebSearch: noop,
  thinking: 'auto' as const,
  onToggleThinking: noop,
  showSlash: false,
  showPlus: false,
  onInputChange: noop,
  onSelectSlashCommand: noop,
  onSend: noop,
  onStop: noop,
  onImagesSelected: noop,
  onTogglePlus: noop,
  onClosePlus: noop,
  onRunModeChange: noop,
  onOpenConnectors: noop,
  onOpenSettingsTab: noop,
} satisfies Partial<React.ComponentProps<typeof Composer>>

const meta = {
  title: 'Chat/Composer',
  component: Composer,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story: () => React.ReactElement) =>
      React.createElement(
        'div',
        { style: { width: 720, maxWidth: '100%', padding: 24 } },
        React.createElement(Story),
      ),
  ],
  args: baseArgs,
} satisfies Meta<typeof Composer>

export default meta
type Story = StoryObj<typeof meta>

/** Empty input — Send is disabled until there is text or a done attachment. */
export const Empty: Story = {}

/** Text entered — the Send affordance lights up. */
export const WithText: Story = { args: { input: 'Draft a migration plan for the ledger table.' } }

/** A run is streaming — Send becomes Stop. */
export const Streaming: Story = {
  args: { input: 'Summarise the incident timeline.', running: true, statusMsg: 'Searching the runbook…' } as never,
}

/** The slash palette open over a `/` prefix (keyboard-navigable). */
export const SlashPaletteOpen: Story = { args: { input: '/', showSlash: true } }

/** Attachments at every upload state: uploading, done, error-with-retry. */
export const Attachments: Story = { args: { attachments } }

/** Pinned workspace-connection chips. */
export const ToolsAndConnections: Story = {
  args: {
    connections: [
      { id: 'w1', name: 'Loop GPT repo', type: 'github' },
      { id: 'w2', name: 'Launch sheet', type: 'google_sheets' },
    ],
    pinnedConnectionId: 'w1',
  },
}

/** Hands-free voice mode: listening for the next turn. */
export const VoiceMode: Story = {
  args: { voiceMode: true, voiceModeSupported: true, voiceModeListening: true, input: 'What changed in the release?' },
}

/** Incognito run + a half-full context meter (the amber state begins past 85%). */
export const IncognitoWithContext: Story = {
  args: { incognito: true, contextPct: 42, contextTokens: 13400 },
}

/** SendButton — ready: accent + glow, paper-plane. */
export const SendReady: Story = { args: { input: 'Ship the redesign.' } }

/** SendButton — running: ■ stop glyph + terracotta pulse ring. */
export const SendRunning: Story = {
  args: { input: 'Summarise the incident timeline.', running: true, statusMsg: 'Searching…' } as never,
}

/** SendButton — queued: stop state + count badge (2 behind the active run). */
export const SendQueued: Story = {
  args: { input: 'And the follow-up.', running: true, queuedCount: 2 } as never,
}

/** High context usage — the meter turns amber. */
export const ContextAlmostFull: Story = { args: { contextPct: 91, contextTokens: 29120 } }

/** Hover — the control row's hover fills. */
export const Hover: Story = {
  args: { input: 'Hover me' },
  play: async ({ canvasElement }) => {
    const { userEvent, within } = await import('@storybook/test')
    const canvas = within(canvasElement)
    await userEvent.hover(canvas.getByRole('button', { name: /add files or photos/i }))
  },
}

/** Focus — the textarea focus ring (globals :focus-visible). */
export const Focused: Story = {
  args: { input: 'Focused input' },
  play: async ({ canvasElement }) => {
    const { within } = await import('@storybook/test')
    const canvas = within(canvasElement)
    const box = canvas.getByRole('textbox')
    box.focus()
  },
}
