import React from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { SendButton } from './SendButton'

/** The composer's primary action: one morphing control, four states. */
const meta = {
  title: 'Chat/SendButton',
  component: SendButton,
  parameters: { layout: 'centered', backgrounds: { default: 'dark' } },
  decorators: [
    (Story) => (
      <div style={{ padding: 32, background: '#08080a', display: 'flex', gap: 24, alignItems: 'center' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SendButton>
export default meta
type Story = StoryObj<typeof meta>

/** Empty input: flat, muted, unmistakably off. */
export const Disabled: Story = { args: { running: false, canSend: false, onStop: () => {} } }

/** Ready: brand accent + glow; hover lifts, press squashes. */
export const Ready: Story = { args: { running: false, canSend: true, onStop: () => {} } }

/** Streaming: ■ stop glyph + terracotta pulse ring. */
export const Running: Story = { args: { running: true, canSend: true, onStop: () => {} } }

/** Two messages queued behind the active run. */
export const Queued: Story = { args: { running: true, canSend: true, queuedCount: 2, onStop: () => {} } }

/** All four states side by side (the design review view). */
export const AllStates: StoryObj = {
  render: () => (
    <>
      <SendButton running={false} canSend={false} onStop={() => {}} />
      <SendButton running={false} canSend onStop={() => {}} />
      <SendButton running canSend onStop={() => {}} />
      <SendButton running canSend queuedCount={3} onStop={() => {}} />
    </>
  ),
}
