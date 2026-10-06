import React from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { ErrorBoundary } from './ErrorBoundary'

const meta: Meta = {
  title: 'App/Error Boundary',
  parameters: { layout: 'fullscreen', backgrounds: { default: 'dark' } },
}
export default meta

function Kaboom(): React.JSX.Element {
  throw new Error('Storybook deliberate crash: the boundary renders, the app stays alive.')
}

export const Crashed: StoryObj = {
  render: () => (
    <ErrorBoundary>
      <Kaboom />
    </ErrorBoundary>
  ),
}

export const Healthy: StoryObj = {
  render: () => (
    <ErrorBoundary>
      <div className="min-h-screen bg-[#08080a] p-6 text-sm text-slate-300">
        Children render normally — the boundary stays invisible.
      </div>
    </ErrorBoundary>
  ),
}