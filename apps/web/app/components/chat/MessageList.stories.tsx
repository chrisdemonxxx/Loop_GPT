import React from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import MessageList from './MessageList'
import type { LiveStep, Message, QueuedMessage } from './types'

const noop = () => {}

const stored: Message[] = [
  {
    id: 'm1',
    role: 'user',
    content: 'What changed in the ledger service this week?',
    createdAt: new Date(Date.now() - 9e5).toISOString(),
  },
  {
    id: 'm2',
    role: 'assistant',
    content:
      'Three changes landed:\n\n1. The ledger now writes settlement rows in one transaction.\n2. `postgres-ssl:16` replaced the hand-rolled TLS shim.\n3. A daily reconciliation job was added.\n\nThe retry backoff caps at 30s with jitter.',
    createdAt: new Date(Date.now() - 8.4e5).toISOString(),
    metadata: {
      sources: [
        { index: 1, title: 'docs/ACCOUNTING.md', url: 'https://example.com/accounting' },
        { index: 2, title: 'docs/DAILY_SETTLEMENT_RECOVERY.md', url: 'https://example.com/settlement' },
      ],
    },
  },
]

const liveSteps: LiveStep[] = [
  {
    index: 0,
    kind: 'tool',
    text: 'grep',
    ts: Date.now() - 4000,
    tool: {
      name: 'search_repo',
      args: { query: 'settlement retry backoff' },
      result: '3 matches in backend/src/settlement.ts',
      durationMs: 412,
    },
  },
  {
    index: 1,
    kind: 'tool',
    text: 'read',
    ts: Date.now() - 2200,
    tool: { name: 'read_file', args: { path: 'docs/ACCOUNTING.md' }, result: '## Ledger writesâ€¦', durationMs: 96 },
  },
]

const queued: QueuedMessage[] = [
  {
    id: 'q1',
    content: 'Also show the reconciliation cron expression.',
    attachmentIds: [],
    previews: [],
    docNames: [],
    sendMode: 'agent',
    runMode: 'auto',
    modelTier: 'loop-auto',
    incognito: false,
  },
]

const meta = {
  title: 'Chat/MessageList',
  component: MessageList,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story: () => React.ReactElement) =>
      React.createElement(
        'div',
        { style: { height: 640, maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column' } },
        React.createElement(Story),
      ),
  ],
  args: {
    messages: [],
    conversationId: 'c1',
    liveUser: null,
    liveSteps: [],
    liveAnswer: '',
    liveThinking: '',
    liveArtifacts: [],
    running: false,
    statusMsg: '',
    mode: 'agent' as const,
    onEditMessage: noop,
    onRetryBefore: noop,
  },
} satisfies Meta<typeof MessageList>

export default meta
type Story = StoryObj<typeof meta>

/** Nothing yet â€” the ChatWelcome hero with prompt starters. */
export const Empty: Story = {}

/** A stored transcript with an assistant answer and its cited sources. */
export const Conversation: Story = { args: { messages: stored } }

/** The live turn mid-stream: user bubble, tool timeline, answer so far. */
export const Streaming: Story = {
  args: {
    messages: stored,
    liveUser: { content: 'Which job reconciles the ledger?' },
    liveSteps,
    liveAnswer: 'The daily reconciliation job runs at 02:15 UTC â€”',
    running: true,
    statusMsg: 'Reading the settlement runbookâ€¦',
  },
}

/** Extended thinking â€” the collapsible reasoning stream, open while unanswered. */
export const Thinking: Story = {
  args: {
    messages: stored,
    liveUser: { content: 'Plan the migration in steps.' },
    liveThinking:
      'First I should inventory the writers, then freeze the table, then backfill in batches. The ledger has ~4M rows, so a single ALTER would lock writes for minutes.',
    running: true,
    statusMsg: 'Thinking',
  },
}

/** A failed turn â€” the inline activity card surfaces Retry. */
export const ErrorState: Story = {
  args: {
    messages: stored,
    liveUser: { content: 'Re-run the backfill.' },
    liveSteps: [
      {
        index: 0,
        kind: 'tool',
        text: 'exec',
        ts: Date.now() - 1200,
        tool: {
          name: 'execute_code',
          args: { language: 'sql' },
          result: 'ERROR: deadlock detected',
          isError: true,
          durationMs: 1890,
        },
      },
    ],
    running: false,
    statusMsg: '',
  },
}

/** Messages queued behind the active run â€” nothing typed is dropped. */
export const Queued: Story = {
  args: { messages: stored, liveUser: { content: 'And the cron expression?' }, running: true, statusMsg: 'working', queued },
}
