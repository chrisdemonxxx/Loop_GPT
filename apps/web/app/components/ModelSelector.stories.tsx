import React from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import ModelSelector from './ModelSelector'

const meta = {
  title: 'Chat/ModelSelector',
  component: ModelSelector,
  parameters: { layout: 'centered' },
  args: { value: 'loop-auto', onChange: () => {} },
} satisfies Meta<typeof ModelSelector>

export default meta
type Story = StoryObj<typeof meta>

/** Closed trigger showing the selected model. */
export const Default: Story = {}

/** The catalog listbox open: tier rows + capability badges + More models. */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const { userEvent, within } = await import('@storybook/test')
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: /choose model/i }))
  },
}

/** The nested Effort submenu open on a row (A6 / GAP-029). */
export const EffortMenuOpen: Story = {
  play: async ({ canvasElement }) => {
    const { userEvent, within } = await import('@storybook/test')
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: /choose model/i }))
    const effort = await canvas.findAllByRole('button', { name: /^Effort:/ })
    await userEvent.click(effort[0])
  },
}

/** A model is selected — the check mark + terracotta brain. */
export const Selected: Story = { args: { value: 'loop-reason' } }
