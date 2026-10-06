import React from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { RunSettings } from './RunSettings'

/** Option A: ONE popover for Autonomy / Web search / Reasoning. */
const meta = {
  title: 'Chat/RunSettings',
  component: RunSettings,
  parameters: { layout: 'centered', backgrounds: { default: 'dark' } },
  decorators: [
    (Story) => (
      <div style={{ padding: 80, paddingTop: 320, background: '#08080a' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RunSettings>
export default meta
type Story = StoryObj<typeof meta>

const noop = () => {}

/** All-default axes: the chip reads "Auto". */
export const Auto: Story = {
  args: { runMode: 'auto', webSearch: 'auto', thinking: 'auto', onRunModeChange: noop, onWebSearchChange: noop, onThinkingChange: noop },
}

/** A non-default axis flips the chip to the accented "Custom" state. */
export const Customized: Story = {
  args: { runMode: 'step', webSearch: 'on', thinking: 'high', onRunModeChange: noop, onWebSearchChange: noop, onThinkingChange: noop },
}
