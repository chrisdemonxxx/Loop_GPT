import React from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import Markdown from './Markdown'

const meta: Meta = {
  title: 'Chat/Markdown + Code Blocks',
  parameters: { layout: 'padded', backgrounds: { default: 'dark' } },
  decorators: [
    (Story) => (
      <div className="max-w-2xl rounded-2xl border border-white/[0.07] bg-[#08080a] p-4 text-slate-200">
        <div className="prose-chat text-[15px] leading-[1.7] text-slate-100"><Story /></div>
      </div>
    ),
  ],
}
export default meta

export const Prose: StoryObj = {
  render: () => (
    <Markdown content={`Regular **bold** and *italic*, a [link](https://loop-gpt.cyou), and an inline \`code\` token.`} />
  ),
}

export const CodeGroup: StoryObj = {
  render: () => (
    <Markdown content={`Fenced block with the copy control:

\`\`\`ts
export function tierFor(model?: string | null): ChatTier {
  if (!model) return 'standard'
  return 'vision'
}
\`\`\``} />
  ),
}

export const MermaidFence: StoryObj = {
  render: () => (
    <Markdown content={`Diagrams render in-flow (lazy mermaid):

\`\`\`mermaid
graph LR
  A[User] --> B{Router}
  B -->|image| C[VLM]
  B -->|text| D[Looper]
\`\`\``} />
  ),
}