import React from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { CommandPalette } from './CommandPalette'

const meta: Meta = {
  title: 'Chat/Command Palette',
  parameters: { layout: 'fullscreen', backgrounds: { default: 'dark' } },
}
export default meta

/**
 * The palette listens for ⌘K — the story dispatches the real hotkey once
 * mounted so the overlay renders without a keypress. Esc or the backdrop
 * closes it.
 */
export const Open: StoryObj = {
  render: () => (
    <div className="flex min-h-[400px] items-center justify-center bg-[#08080a] text-sm text-slate-500">
      <CommandPalette
        onNewSession={() => {}}
        onToggleSidebar={() => {}}
        onSearchChats={() => {}}
        onOpenSettings={() => {}}
        onLogout={() => {}}
      />
      <HotkeyOpener />
    </div>
  ),
}

function HotkeyOpener() {
  React.useEffect(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
  }, [])
  return null
}