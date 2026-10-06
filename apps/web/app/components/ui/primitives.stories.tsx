import React from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { Toggle, Badge, Card, SectionHeader, EmptyState, StatusDot, SearchInput, Skeleton } from './primitives'
import { Inbox, Star } from 'lucide-react'

const meta: Meta = {
  title: 'UI/Primitives',
  parameters: { layout: 'padded' },
}
export default meta

export const ToggleOff: StoryObj = { render: () => <Toggle on={false} onChange={() => {}} label="Response completions" /> }
export const ToggleOn: StoryObj = { render: () => <Toggle on={true} onChange={() => {}} label="Help improve models" /> }

export const Badges: StoryObj = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Badge>neutral</Badge>
      <Badge tone="accent">accent</Badge>
      <Badge tone="green">connected</Badge>
    </div>
  ),
}

export const StatusDots: StoryObj = {
  render: () => (
    <div className="flex items-center gap-4 text-sm text-slate-300">
      {(['idle', 'working', 'waiting', 'error', 'ok'] as const).map((s) => (
        <span key={s} className="flex items-center gap-1.5"><StatusDot state={s} /> {s}</span>
      ))}
    </div>
  ),
}

export const CardVariants: StoryObj = {
  render: () => (
    <div className="grid max-w-md gap-2">
      <Card title="With badge and action" description="The card body copy goes here." badge={<Badge tone="accent">beta</Badge>} />
      <Card title="Plain card" description="No badge, no action — the default list row." />
    </div>
  ),
}

export const SectionHeaders: StoryObj = {
  render: () => (
    <div className="space-y-3">
      <SectionHeader title="Connected" count={3} />
      <SectionHeader title="Yours" count={null} />
      <SectionHeader title="With action" action={<button className="text-xs text-[#e79d7f] hover:underline">Add</button>} />
    </div>
  ),
}

export const EmptyStates: StoryObj = {
  render: () => (
    <div className="grid max-w-md gap-3">
      <EmptyState icon={<Inbox size={20} />} title="No shared content found" body="Chats you share links to will appear here." />
      <EmptyState icon={<Star size={20} />} title="No feedback yet" action={<button className="mt-2 text-xs text-[#e79d7f] hover:underline">Rate a response</button>} />
    </div>
  ),
}

/** Stateful wrapper: hooks can't run inside a story's `render` arrow. */
function SearchStateful() {
  const [v, setV] = React.useState('')
  return <div className="max-w-md"><SearchInput value={v} onChange={setV} placeholder="Search connectors…" resultCount={v ? 2 : null} /></div>
}

export const Search: StoryObj = {
  render: () => <SearchStateful />,
}

export const Skeletons: StoryObj = {
  render: () => (
    <div className="max-w-md space-y-4">
      <div className="space-y-1"><div className="text-xs text-slate-500">lines</div><Skeleton /></div>
      <div className="space-y-1"><div className="text-xs text-slate-500">card (directory loading state)</div><Skeleton variant="card" /></div>
    </div>
  ),
}