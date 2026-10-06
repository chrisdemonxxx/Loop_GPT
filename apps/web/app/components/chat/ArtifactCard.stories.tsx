import React from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { ArtifactCard } from './ArtifactCard'
import type { ArtifactRef } from '../../lib/stream'

const meta = {
  title: 'Chat/ArtifactCard',
  component: ArtifactCard,
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactElement) =>
      React.createElement('div', { style: { padding: 24 } }, React.createElement(Story)),
  ],
} satisfies Meta<typeof ArtifactCard>

export default meta
type Story = StoryObj<typeof meta>

const doc: ArtifactRef = {
  id: 'a1',
  kind: 'markdown',
  name: 'deploy-runbook.md',
  url: '/api/files/a1/content',
}

const sheet: ArtifactRef = {
  id: 'a2',
  kind: 'xlsx',
  name: 'cost-model.xlsx',
  url: '/api/files/a2/content',
}

const image: ArtifactRef = {
  id: 'a3',
  kind: 'image',
  name: 'hero-mock.png',
  url: '/api/files/a3/content',
}

/** The default download chip for a non-media artifact. */
export const FileChip: Story = { args: { a: doc } }

/** A spreadsheet artifact (also a chip — no inline preview). */
export const SheetChip: Story = { args: { a: sheet } }

/** An image artifact: shimmer reserved while the authed blob loads. */
export const ImageLoading: Story = { args: { a: image } }

/** Hover state — the download affordance appears. */
export const Hover: Story = {
  args: { a: doc },
  play: async ({ canvasElement }) => {
    const { userEvent, within } = await import('@storybook/test')
    const canvas = within(canvasElement)
    await userEvent.hover(canvas.getByRole('button'))
  },
}
