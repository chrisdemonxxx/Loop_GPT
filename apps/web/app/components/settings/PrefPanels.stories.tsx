import React from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import GeneralTab from './GeneralTab'
import TimeFocusTab from './TimeFocusTab'
import CodeTab from './CodeTab'

const meta: Meta = {
  title: 'Settings/Pref Panels',
  parameters: { layout: 'padded', backgrounds: { default: 'dark' } },
  decorators: [
    (Story) => (
      <div className="min-h-[400px] rounded-2xl border border-white/[0.07] bg-[#08080a] p-4 text-slate-200">
        <div className="mx-auto max-w-lg"><Story /></div>
      </div>
    ),
  ],
}
export default meta

/** The prefs panels read/write localStorage (loop-prefs/v1) — no API needed. */
export const General: StoryObj = { render: () => <GeneralTab /> }
export const TimeAndFocus: StoryObj = { render: () => <TimeFocusTab /> }
export const LoopCode: StoryObj = { render: () => <CodeTab /> }