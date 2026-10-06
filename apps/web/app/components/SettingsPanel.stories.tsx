import React from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import SettingsPanel from './SettingsPanel'

const meta: Meta = {
  title: 'Settings/Panel',
  parameters: { layout: 'fullscreen', backgrounds: { default: 'dark' } },
}
export default meta

function Shell({ initialTab, children }: { initialTab?: string; children?: React.ReactNode }) {
  const [open, setOpen] = React.useState(true)
  return (
    <div className="min-h-screen bg-[#08080a]">
      {/* Storybook canvas body copy so the dialog reads in context */}
      <div className="p-6 text-sm text-slate-500">{children}</div>
      {open && <SettingsPanel initialTab={initialTab} onClose={() => setOpen(false)} />}
    </div>
  )
}

/** Skills list fetch — the panel's tabs call APIs; stub them. */
window.fetch = async () => ({ ok: true, json: async () => [] }) as Response

export const GeneralPanel: StoryObj = { render: () => <Shell initialTab="general" /> }
export const AccountPanel: StoryObj = {
  render: () => (
    <Shell initialTab="account">
      account fetch is stubbed — signed-out states render honestly
    </Shell>
  ),
}
export const LoopCodePanel: StoryObj = { render: () => <Shell initialTab="code" /> }
export const FullRegistry: StoryObj = {
  render: () => <Shell />,
}